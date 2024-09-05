'use strict';

const _ = require('lodash');

const user = require('../user');
const groups = require('../groups');
const meta = require('../meta');
const posts = require('../posts');
const db = require('../database');
const flags = require('../flags');
const analytics = require('../analytics');
const plugins = require('../plugins');
const pagination = require('../pagination');
const privileges = require('../privileges');
const utils = require('../utils');
const helpers = require('./helpers');

const modsController = module.exports;
modsController.flags = {};

// The following function has been broken down with helper functions to reduce cognitive complexity
modsController.flags.list = async function (req, res) {
	console.log('mods.js has been loaded and is executing. The listing function for the flags is functional with refactored code.');
	const [isAdminOrGlobalMod, moderatedCids,, { sorts }] = await initialize(req);
	let [,, { filters }] = await initialize(req);

	if (!checkAccess(isAdminOrGlobalMod, moderatedCids, req, res)) {
		return;
	}

	filters = parseFilters(req, filters);
	filters = adjustFiltersForMod(filters, res);
	let hasFilter = determineHasFilter(filters);
	const sort = parseSort(req, sorts);
	hasFilter = hasFilter || !!sort;

	const [flagsData, analyticsData, selectData] = await fetchData(req, filters, sort);
	const selected = await getSelectedUsers(filters);

	res.render('flags/list', {
		flags: flagsData.flags,
		count: flagsData.count,
		analytics: analyticsData,
		selectedCategory: selectData.selectedCategory,
		selected,
		hasFilter: hasFilter,
		filters: filters,
		expanded: !!(filters.assignee || filters.reporterId || filters.targetUid),
		sort: sort || 'newest',
		title: '[[pages:flags]]',
		pagination: pagination.create(flagsData.page, flagsData.pageCount, req.query),
		breadcrumbs: helpers.buildBreadcrumbs([{ text: '[[pages:flags]]' }]),
	});
};

function initialize(req) {
	const validFilters = ['assignee', 'state', 'reporterId', 'type', 'targetUid', 'cid', 'quick', 'page', 'perPage'];
	const validSorts = ['newest', 'oldest', 'reports', 'upvotes', 'downvotes', 'replies'];

	return Promise.all([
		user.isAdminOrGlobalMod(req.uid),
		user.getModeratedCids(req.uid),
		plugins.hooks.fire('filter:flags.validateFilters', { filters: validFilters }),
		plugins.hooks.fire('filter:flags.validateSort', { sorts: validSorts }),
	]);
}

function checkAccess(isAdminOrGlobalMod, moderatedCids, req, res) {
	if (!(isAdminOrGlobalMod || !!moderatedCids.length)) {
		helpers.notAllowed(req, res);
		return false;
	}
	if (!isAdminOrGlobalMod && moderatedCids.length) {
		res.locals.cids = moderatedCids.map(cid => String(cid));
	}
	return true;
}

function parseFilters(req, filters) {
	return filters.reduce((memo, cur) => {
		if (req.query.hasOwnProperty(cur)) {
			if (typeof req.query[cur] === 'string' && req.query[cur].trim() !== '') {
				memo[cur] = req.query[cur].trim();
			} else if (Array.isArray(req.query[cur]) && req.query[cur].length) {
				memo[cur] = req.query[cur];
			}
		}
		return memo;
	}, {});
}

function adjustFiltersForMod(filters, res) {
	if (res.locals.cids) {
		if (!filters.cid) {
			filters.cid = res.locals.cids;
		} else if (Array.isArray(filters.cid)) {
			filters.cid = filters.cid.filter(cid => res.locals.cids.includes(String(cid)));
		} else if (!res.locals.cids.includes(String(filters.cid))) {
			filters.cid = res.locals.cids;
		}
	}
	return filters;
}

function determineHasFilter(filters) {
	return !!Object.keys(filters).length &&
		!(Object.keys(filters).length === 1 && filters.hasOwnProperty('page')) &&
		!(Object.keys(filters).length === 2 && filters.hasOwnProperty('page') && filters.hasOwnProperty('perPage'));
}

function parseSort(req, sorts) {
	let sort = null;
	if (req.query.sort && sorts.includes(req.query.sort)) {
		sort = req.query.sort;
	}
	return sort === 'newest' ? undefined : sort;
}

async function fetchData(req, filters, sort) {
	return Promise.all([
		flags.list({
			filters: filters,
			sort: sort,
			uid: req.uid,
			query: req.query,
		}),
		analytics.getDailyStatsForSet('analytics:flags', Date.now(), 30),
		helpers.getSelectedCategory(filters.cid),
	]);
}

async function getSelectedUsers(filters) {
	const selected = {};
	await Promise.all(['assignee', 'reporterId', 'targetUid'].map(async (filter) => {
		let uids = filters[filter];
		if (!uids) {
			selected[filter] = [];
			return;
		}
		if (!Array.isArray(uids)) {
			uids = [uids];
		}

		selected[filter] = await user.getUsersFields(uids, ['username', 'userslug', 'picture']);
	}));
	return selected;
}

modsController.flags.detail = async function (req, res, next) {
	const results = await utils.promiseParallel({
		isAdminOrGlobalMod: user.isAdminOrGlobalMod(req.uid),
		moderatedCids: user.getModeratedCids(req.uid),
		flagData: flags.get(req.params.flagId),
		privileges: Promise.all(['global', 'admin'].map(async type => privileges[type].get(req.uid))),
	});
	results.privileges = { ...results.privileges[0], ...results.privileges[1] };
	if (!results.flagData || (!(results.isAdminOrGlobalMod || !!results.moderatedCids.length))) {
		return next(); // 404
	}

	// extra checks for plain moderators
	if (!results.isAdminOrGlobalMod) {
		if (results.flagData.type === 'user') {
			return next();
		}
		if (results.flagData.type === 'post') {
			const isFlagInModeratedCids = await db.isMemberOfSortedSets(
				results.moderatedCids.map(cid => `flags:byCid:${cid}`),
				results.flagData.flagId
			);
			if (!isFlagInModeratedCids.includes(true)) {
				return next();
			}
		}
	}


	async function getAssignees(flagData) {
		let uids = [];
		const [admins, globalMods] = await Promise.all([
			groups.getMembers('administrators', 0, -1),
			groups.getMembers('Global Moderators', 0, -1),
		]);
		if (flagData.type === 'user') {
			uids = await privileges.admin.getUidsWithPrivilege('admin:users');
			uids = _.uniq(admins.concat(uids));
		} else if (flagData.type === 'post') {
			const cid = await posts.getCidByPid(flagData.targetId);
			uids = _.uniq(admins.concat(globalMods));
			if (cid) {
				const modUids = (await privileges.categories.getUidsWithPrivilege([cid], 'moderate'))[0];
				uids = _.uniq(uids.concat(modUids));
			}
		}
		const userData = await user.getUsersData(uids);
		return userData.filter(u => u && u.userslug);
	}

	const assignees = await getAssignees(results.flagData);
	results.flagData.history = await flags.getHistory(req.params.flagId);

	if (results.flagData.type === 'user') {
		results.flagData.type_path = 'uid';
	} else if (results.flagData.type === 'post') {
		results.flagData.type_path = 'post';
	}

	res.render('flags/detail', Object.assign(results.flagData, {
		assignees: assignees,
		type_bool: ['post', 'user', 'empty'].reduce((memo, cur) => {
			if (cur !== 'empty') {
				memo[cur] = results.flagData.type === cur && (
					!results.flagData.target ||
					!!Object.keys(results.flagData.target).length
				);
			} else {
				memo[cur] = !Object.keys(results.flagData.target).length;
			}

			return memo;
		}, {}),
		states: Object.fromEntries(flags._states),
		title: `[[pages:flag-details, ${req.params.flagId}]]`,
		privileges: results.privileges,
		breadcrumbs: helpers.buildBreadcrumbs([
			{ text: '[[pages:flags]]', url: '/flags' },
			{ text: `[[pages:flag-details, ${req.params.flagId}]]` },
		]),
	}));
};

modsController.postQueue = async function (req, res, next) {
	if (!req.loggedIn) {
		return next();
	}
	const { id } = req.params;
	const { cid } = req.query;
	const page = parseInt(req.query.page, 10) || 1;
	const postsPerPage = 20;

	let postData = await posts.getQueuedPosts({ id: id });
	let [isAdmin, isGlobalMod, moderatedCids, categoriesData, _privileges] = await Promise.all([
		user.isAdministrator(req.uid),
		user.isGlobalModerator(req.uid),
		user.getModeratedCids(req.uid),
		helpers.getSelectedCategory(cid),
		Promise.all(['global', 'admin'].map(async type => privileges[type].get(req.uid))),
	]);
	_privileges = { ..._privileges[0], ..._privileges[1] };

	postData = postData
		.filter(p => p &&
			(!categoriesData.selectedCids.length || categoriesData.selectedCids.includes(p.category.cid)) &&
			(isAdmin || isGlobalMod || moderatedCids.includes(Number(p.category.cid)) || req.uid === p.user.uid))
		.map((post) => {
			const isSelf = post.user.uid === req.uid;
			post.canAccept = !isSelf && (isAdmin || isGlobalMod || !!moderatedCids.length);
			return post;
		});

	({ posts: postData } = await plugins.hooks.fire('filter:post-queue.get', {
		posts: postData,
		req: req,
	}));

	const pageCount = Math.max(1, Math.ceil(postData.length / postsPerPage));
	const start = (page - 1) * postsPerPage;
	const stop = start + postsPerPage - 1;
	postData = postData.slice(start, stop + 1);
	const crumbs = [{ text: '[[pages:post-queue]]', url: id ? '/post-queue' : undefined }];
	if (id && postData.length) {
		const text = postData[0].data.tid ? '[[post-queue:reply]]' : '[[post-queue:topic]]';
		crumbs.push({ text: text });
	}
	res.render('post-queue', {
		title: '[[pages:post-queue]]',
		posts: postData,
		isAdmin: isAdmin,
		canAccept: isAdmin || isGlobalMod,
		...categoriesData,
		allCategoriesUrl: `post-queue${helpers.buildQueryString(req.query, 'cid', '')}`,
		pagination: pagination.create(page, pageCount),
		breadcrumbs: helpers.buildBreadcrumbs(crumbs),
		enabled: meta.config.postQueue,
		singlePost: !!id,
		privileges: _privileges,
	});
};
