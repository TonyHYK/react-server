
var logger = require('./logging').getLogger(__LOGGER__),
	React = require('react'),
	MobileDetect = require('mobile-detect'),
	RequestContext = require('./context/RequestContext'),
	RequestLocalStorage = require('./util/RequestLocalStorage'),
	RLS = RequestLocalStorage.getNamespace(),
	LABString = require('./util/LABString'),
	Q = require('q'),
	config = require('./config'),
	ExpressServerRequest = require("./ExpressServerRequest"),
	expressState = require('express-state'),
	cookieParser = require('cookie-parser'),
	PageUtil = require("./util/PageUtil"),
	TritonAgent = require('./TritonAgent'),
	StringEscapeUtil = require('./util/StringEscapeUtil'),
	{PAGE_CSS_NODE_ID, PAGE_LINK_NODE_ID, PAGE_CONTENT_NODE_ID} = require('./constants');


// TODO FIXME ??
// It *might* be worthwhile to get rid of all the closure-y things in render()
// https://developers.google.com/speed/articles/optimizing-javascript

// If an element hasn't rendered in this long it gets the axe.
var FAILSAFE_RENDER_TIMEOUT = 20e3;

// We'll use this for keeping track of request concurrency per worker.
var ACTIVE_REQUESTS = 0;

// Some non-content items that can live in the elements array.
var ELEMENT_PENDING         = -1;
var ELEMENT_ALREADY_WRITTEN = -2;

/**
 * renderMiddleware entrypoint. Called by express for every request.
 */
module.exports = function(server, routes) {

	expressState.extend(server);

	// parse cookies into req.cookies property
	server.use(cookieParser());

	// sets the namespace that data will be exposed into client-side
	// TODO: express-state doesn't do much for us until we're using a templating library
	server.set('state namespace', '__tritonState');

	server.use((req, res, next) => { RequestLocalStorage.startRequest(() => {
		ACTIVE_REQUESTS++;

		var start = RLS().startTime = new Date();
		var startHR = process.hrtime();

		logger.debug(`Incoming request for ${req.path}`);

		// Just to keep an eye out for leaks.
		logger.gauge("requestLocalStorageNamespaces", RequestLocalStorage.getCountNamespaces());

		// monkey-patch `res.write` so that we don't try to write to the stream if it's
		// already closed
		var origWrite = res.write;
		res.write = function () {
			if (!res.finished) {
				origWrite.apply(res, arguments);
			} else {
				logger.error("Attempted write after response finished", { path: req && req.path || "unknown", stack: logger.stack() });
			}
		};

		// TODO? pull this context building into its own middleware
		var context = new RequestContext.Builder()
				.setRoutes(routes)
				.setDefaultXhrHeadersFromRequest(req)
				.create({
					// TODO: context opts?
				});

		// Need this stuff in corvair for logging.
		context.setServerStash({ req, res, start, startHR });

		context.setMobileDetect(new MobileDetect(req.get('user-agent')));

		// setup navigation handler (TODO: should we have a 'once' version?)
		context.onNavigate( (err, page) => {

			if (err) {
				logger.log("onNavigate received a non-2xx HTTP code", err);
				if (err.status && err.status === 404) {
					next();
				} else if (err.status === 301 || err.status === 302) {
					res.redirect(err.status, err.redirectUrl);
				} else {
					next(err);
				}
				handleResponseComplete(req, res, context, start, page);
				return;
			}

			renderPage(req, res, context, start, page);

		});

		context.navigate(new ExpressServerRequest(req));

	})});
}

module.exports.getActiveRequests = () => ACTIVE_REQUESTS;

function handleResponseComplete(req, res, context, start, page) {

	res.on('finish', RequestLocalStorage.bind(() => {

		// All intentional response completion should funnel through
		// this function.  If this value starts climbing gradually
		// that's an indication that we have some _unintentional_
		// response completion going on that we should deal with.
		ACTIVE_REQUESTS--;

		// Note that if the navigator couldn't even map the request to
		// a page, we won't be able to call middleware
		// `handleComplete()` here.
		//
		if (page) {
			logRequestStats(req, res, context, start, page);

			page.handleComplete();
		}
	}));
}

function renderPage(req, res, context, start, page) {

	var routeName = context.navigator.getCurrentRoute().name;

	logger.debug("Route Name: " + routeName);

	var renderTimer = logger.timer("renderFunction");

	res.status(page.getStatus()||200);

	// Each of these functions has the same signature and returns a
	// promise, so we can chain them up with a promise reduction.
	var lifecycleMethods;
	if (PageUtil.PageConfig.get('isFragment')){
		lifecycleMethods = fragmentLifecycle();
	} else if (PageUtil.PageConfig.get('isRawResponse')){
		lifecycleMethods = rawResponseLifecycle();
	} else {
		lifecycleMethods = pageLifecycle();
	}

	lifecycleMethods.reduce((chain, func) => chain
		.then(() => func(req, res, context, start, page))
		.then(() => renderTimer.tick(func.name))
	).catch(err => {
		logger.error("Error in renderPage chain", err)

		// Bummer.
		res.status(500).end();

		handleResponseComplete(req, res, context, start, page);
	});

	// TODO: we probably want a "we're not waiting any longer for this"
	// timeout as well, and cancel the waiting deferreds
}

function rawResponseLifecycle () {
	return [
		Q(), // NOOP lead-in to prime the reduction
		setContentType,
		writeResponseData,
		endResponse,
		handleResponseComplete,
	];
}

function fragmentLifecycle () {
	return [
		Q(), // NOOP lead-in to prime the reduction
		setContentType,
		writeDebugComments,
		writeBody,
		endResponse,
		handleResponseComplete,
	];
}

function pageLifecycle() {
	return [
		Q(), // This is just a NOOP lead-in to prime the reduction.
		setContentType,
		writeHeader,
		startBody,
		writeBody,
		wrapUpLateArrivals,
		closeBody,
		endResponse,
		handleResponseComplete,
	];
}

function setContentType(req, res, context, start, pageObject) {
	res.set('Content-Type', pageObject.getContentType());
}

function writeHeader(req, res, context, start, pageObject) {
	res.type('html');
	res.set('Transfer-Encoding', 'chunked');

	res.write("<!DOCTYPE html><html><head>");

	// note: these responses can currently come back out-of-order, as many are returning
	// promises. scripts and stylesheets are guaranteed
	return Q.all([
		renderDebugComments(pageObject, res),
		renderTimingInit(pageObject, res),
		renderTitle(pageObject, res),
		renderStylesheets(pageObject, res),
		renderScripts(pageObject, res),
		renderMetaTags(pageObject, res),
		renderLinkTags(pageObject, res),
		renderBaseTag(pageObject, res),
	]).then(() => {
		// once we have finished rendering all of the pieces of the head element, we
		// can close the head and start the body element.
		res.write(`</head>`);

		// Get headers out right away so secondary resource download can start.
		flushRes(res);
	});
}

function flushRes(res){

	// This method is only defined on the response object if the compress
	// middleware is installed, so we need to guard our calls.
	if (res.flush) {
		res.flush()
		if (!RLS().didLogFirstFlush){
			RLS().didLogFirstFlush = true;
			logger.time('firstFlush', new Date - RLS().startTime);
		}
	}
}

function renderTimingInit(pageObject, res) {
	// This is awkward and imprecise.  We don't want to put `<script>`
	// tags between divs above the fold, so we're going to keep separate
	// track of time client and server side. Then we'll put `<noscript>`
	// tags with data elements representing offset from our _server_ base
	// time that we'll apply to our _client_ base time as a proxy for when
	// the element arrived (when it's actually when we _sent_ it).
	//
	RLS().timingDataT0 = new Date;
	renderScriptsSync([{text:`__tritonTimingStart=new Date`}], res)
}

function renderDebugComments (pageObject, res) {
	var debugComments = pageObject.getDebugComments();
	debugComments.map(debugComment => {
		if (!debugComment.label || !debugComment.value) {
			logger.warning("Debug comment is missing either a label or a value", debugComment);
		}

		res.write(`<!-- ${debugComment.label}: ${debugComment.value} -->`);
	});

	// resolve immediately.
	return Q("");
}

function writeDebugComments (req, res, context, start, pageObject) {
	return Q(renderDebugComments(pageObject, res));
}

function renderTitle (pageObject, res) {
	return pageObject.getTitle().then((title) => {
		res.write(`<title>${title}</title>`);
	});
}

function attrfy (value) {
	return value.replace(/"/g, '&quot;');
}

function renderMetaTags (pageObject, res) {
	var metaTags = pageObject.getMetaTags();

	var metaTagsRendered = metaTags.map(metaTagPromise => {
		return metaTagPromise.then(PageUtil.makeArray).then(metaTags => metaTags.forEach(metaTag => {
			// TODO: escaping
			if ((metaTag.name && metaTag.httpEquiv) || (metaTag.name && metaTag.charset) || (metaTag.charset && metaTag.httpEquiv)) {
				throw new Error("Meta tag cannot have more than one of name, httpEquiv, and charset", metaTag);
			}

			if ((metaTag.name && !metaTag.content) || (metaTag.httpEquiv && !metaTag.content)) {
				throw new Error("Meta tag has name or httpEquiv but does not have content", metaTag);
			}

			if (metaTag.noscript) res.write(`<noscript>`);
			res.write(`<meta`);

			if (metaTag.name)      res.write(` name="${attrfy(metaTag.name)}"`);
			if (metaTag.httpEquiv) res.write(` http-equiv="${attrfy(metaTag.httpEquiv)}"`);
			if (metaTag.charset)   res.write(` charset="${attrfy(metaTag.charset)}"`);
			if (metaTag.property)  res.write(` property="${attrfy(metaTag.property)}"`);
			if (metaTag.content)   res.write(` content="${attrfy(metaTag.content)}"`);

			res.write(`>`)
			if (metaTag.noscript) res.write(`</noscript>`);
		}));
	});

	return Q.all(metaTagsRendered);
}

function renderLinkTags (pageObject, res) {
	var linkTags = pageObject.getLinkTags();

	var linkTagsRendered = linkTags.map(linkTagPromise => {
		return linkTagPromise.then(PageUtil.makeArray).then(linkTags => linkTags.forEach(linkTag => {

			if (!linkTag.rel) {
				throw new Error(`<link> tag specified without 'rel' attr`);
			}

			res.write(`<link ${PAGE_LINK_NODE_ID} ${
				Object.keys(linkTag)
					.map(attr => `${attr}="${attrfy(linkTag[attr])}"`)
					.join(' ')
			}>`);
		}));
	});

	return Q.all(linkTagsRendered);
}

function renderBaseTag(pageObject, res) {
	return pageObject.getBase().then((base) => {
		if (base !== null) {
			if (!base.href && !base.target) {
				throw new Error("<base> needs at least one of 'href' or 'target'");
			}
			var tag = "<base";
			if (base.href) {
				tag += ` href="${attrfy(base.href)}"`;
			}
			if (base.target) {
				tag += ` target="${attrfy(base.target)}"`;
			}
			tag += ">";
			res.write(tag);
		}
	});
}

function renderScriptsSync(scripts, res) {

	// right now, the getXXXScriptFiles methods return synchronously, no promises, so we can render
	// immediately.
	scripts.forEach( (script) => {
		// make sure there's a leading '/'
		if (!script.type) script.type = "text/javascript";

		if (script.href) {
			res.write(`<script src="${script.href}" type="${script.type}"></script>`);
		} else if (script.text) {
			res.write(`<script type="${script.type}">${script.text}</script>`);
		} else {
			throw new Error("Script cannot be rendered because it has neither an href nor a text attribute: " + script);
		}
	});
}

function renderScriptsAsync(scripts, res) {

	// Nothing to do if there are no scripts.
	if (!scripts.length) return;

	// Don't need "type" in <script> tags anymore.
	//
	// http://www.w3.org/TR/html/scripting-1.html#the-script-element
	//
	// > The default, which is used if the attribute is absent, is "text/javascript".
	//
	res.write("<script>");

	// Lazily load LAB the first time we spit out async scripts.
	if (!RLS().didLoadLAB){

		// This is the full implementation of LABjs.
		res.write(LABString);

		// We always want scripts to be executed in order.
		res.write("$LAB.setGlobalDefaults({AlwaysPreserveOrder:true});");

		// We'll use this to store state between calls (see below).
		res.write("window._tLAB=$LAB")

		// Only need to do this part once.
		RLS().didLoadLAB = true;
	} else {

		// The assignment to `_tLAB` here is so we maintain a single
		// LAB chain through all of our calls to `renderScriptsAsync`.
		//
		// Each call to this function emits output that looks
		// something like:
		//
		//   _tLAB=_tLAB.script(...).wait(...) ...
		//
		// The result is that `window._tLAB` winds up holding the
		// final state of the LAB chain after each call, so that same
		// LAB chain can be appended to in the _next_ call (if there
		// is one).
		//
		// You can think of a LAB chain as being similar to a promise
		// chain.  The output of `$LAB.script()` or `$LAB.wait()` is
		// an object that itself has `script()` and `wait()` methods.
		// So long as the output of each call is used as the input for
		// the next call our code (both async loaded scripts and
		// inline JS) will be executed _in order_.
		//
		// If we start a _new_ chain directly from `$LAB` (the root
		// chain), we can wind up with _out of order_ execution.
		//
		// We want everything to be executed in order, so we maintain
		// one master chain for the page.  This chain is
		// `window._tLAB`.
		//
		res.write("_tLAB=_tLAB");
	}

	scripts.forEach(script => {

		if (script.href) {
			var LABScript = { src: script.href };

			if (script.crossOrigin){
				LABScript.crossOrigin = script.crossOrigin;
			}

			// If we don't have any other options we can shave a
			// few bytes by just passing the string.
			if (Object.keys(LABScript).length === 1){
				LABScript = LABScript.src;
			}

			if (script.condition) {
				res.write(`.script(function(){if(${script.condition}) return ${JSON.stringify(LABScript)}})`);
			} else {
				res.write(`.script(${JSON.stringify(LABScript)})`);
			}

		} else if (script.text) {
			if (script.condition) {
				throw new Error("Script using `text` cannot be loaded conditionally");
			}

			// The try/catch dance here is so exceptions get their
			// own time slice and can't mess with execution of the
			// LAB chain.
			//
			// The binding to `this` is so enclosed references to
			// `this` correctly get the `window` object (despite
			// being in a strict context).
			//
			res.write(`.wait(function(){${
				script.strict?'"use strict";':''
			}try{${
				script.text
			}}catch(e){setTimeout(function(){throw(e)},1)}}.bind(this))`);

		} else {

			throw new Error("Script needs either `href` or `text`: " + script);
		}
	});

	res.write(";</script>");
}

function renderScripts(pageObject, res) {

	// Want to gather these into one list of scripts, because we care if
	// there are any non-JS scripts in the whole bunch.
	var scripts = pageObject.getSystemScripts().concat(pageObject.getScripts());

	var thereIsAtLeastOneNonJSScript = scripts.filter(
		script => script.type && script.type !== "text/javascript"
	).length;

	if (thereIsAtLeastOneNonJSScript){

		// If there are non-JS scripts we can't use LAB for async
		// loading.  We still want to preserve script execution order,
		// so we'll cut over to all-synchronous loading.
		renderScriptsSync(scripts, res);
	} else {

		// Otherwise, we can do async script loading.
		renderScriptsAsync(scripts, res);
	}

	// resolve immediately.
	return Q("");
}

function renderStylesheets (pageObject, res) {
	pageObject.getHeadStylesheets().forEach((styleSheet) => {
		if (styleSheet.href) {
			res.write(`<link rel="stylesheet" type="${styleSheet.type}" media="${styleSheet.media}" href="${styleSheet.href}" ${PAGE_CSS_NODE_ID}>`);
		} else if (styleSheet.text) {
			res.write(`<style type="${styleSheet.type}" media="${styleSheet.media}" ${PAGE_CSS_NODE_ID}>${styleSheet.text}</style>`);
		} else {
			throw new Error("Style cannot be rendered because it has neither an href nor a text attribute: " + styleSheet);
		}
	});

	// resolve immediately.
	return Q("");
}

function startBody(req, res, context, start, page) {

	var routeName = context.navigator.getCurrentRoute().name

	return page.getBodyClasses().then((classes) => {
		classes.push(`route-${routeName}`)
		res.write(`<body class='${classes.join(' ')}'>`);
	}).then(() => page.getBodyStartContent()).then((texts) => texts.forEach((text) => {
		res.write(text);
	})).then(() => {
		res.write(`<div id='content' ${PAGE_CONTENT_NODE_ID}>`);
	});
}

/**
 * Writes out the ReactElements to the response. Returns a promise that fulfills when
 * all the ReactElements have been written out.
 */
function writeBody(req, res, context, start, page) {

	// standardize to an array of EarlyPromises of ReactElements
	var elementPromises = PageUtil.standardizeElements(page.getElements());

	// No JS until the HTML above the fold has made it through.
	// Need this to be an integer value greater than zero.
	RLS().atfCount = Math.max(page.getAboveTheFoldCount()|0, 1);

	// This is where we'll store our rendered HTML strings.  A value of
	// `undefined` means we haven't rendered that element yet.
	var rendered = elementPromises.map(() => ELEMENT_PENDING);

	// We need to return a promise that resolves when we're done, so we'll
	// maintain an array of deferreds that we punch out as we render
	// elements and we'll return a promise that resolves when they've all
	// been hit.
	var dfds = elementPromises.map(() => Q.defer());

	var doElement = (element, index) => {

		// Exceeded `FAILSAFE_RENDER_TIMEOUT`.  Bummer.
		if (rendered[index] === ELEMENT_ALREADY_WRITTEN) return;

		rendered[index] = renderElement(res, element, context);

		// If we've just rendered the next element to be written we'll
		// write it out.
		writeElements(res, rendered);

		dfds[index].resolve();
	};

	// Render elements as their data becomes available.
	elementPromises.forEach((promise, index) => promise
		.then(element => doElement(element, index))
		.catch(e => logger.error(`Error rendering element ${index}`, e))
	);

	// Some time has already elapsed since the request started.
	// Note that you can override `FAILSAFE_RENDER_TIMEOUT` with a
	// `?_debug_render_timeout={ms}` query string parameter.
	var totalWait     = req.query._debug_render_timeout || FAILSAFE_RENDER_TIMEOUT
	,   timeRemaining = totalWait - (new Date - start)

	var retval = Q.defer();

	// If we exceed the timeout then we'll just send empty elements for
	// anything that hadn't rendered yet.
	retval.promise.catch(() => {

		// Write out what we've got.
		writeElements(res, rendered.map(
			value => value === ELEMENT_PENDING?'':value
		));

		// If it hasn't arrived by now, we're not going to wait for it.
		RLS().lateArrivals = undefined;

		// Let the client know it's not getting any more data.
		renderScriptsAsync([{ text: `__tritonFailArrival()` }], res)
	});

	Q.all(dfds.map(dfd => dfd.promise)).then(retval.resolve);

	setTimeout(() => retval.reject("Timed out rendering"), timeRemaining);

	return retval.promise;
}

function writeResponseData(req, res, context, start, page) {
	page.setExpressRequest(req);
	page.setExpressResponse(res);
	return page.getResponseData().then(data => {
		if (typeof data !== 'undefined') {
			res.write(data);
		}
	});
}

function renderElement(res, element, context) {
	var name  = PageUtil.getElementDisplayName(element)
	,   start = RLS().startTime
	,   timer = logger.timer(`renderElement.individual.${name}`)
	,   html  = ''

	try {
		if (element !== null) {
			html = React.renderToString(
				React.cloneElement(element, { context: context })
			);
		}
	} catch (err) {
		// A component failing to render is not fatal.  We've already
		// started the page with a 200 response.  We've even opened
		// the `data-triton-root-id` div for this component.  We need
		// to close it out and move on.  This is a bummer, and we'll
		// log it, but it's too late to totally bail out.
		logger.error(`Error rendering element ${name}`, err);
	}

	// We time how long _this_ element's render took, and also how long
	// since the beginning of the request it took us to spit this element
	// out.
	var individualTime = timer.stop();
	logger.time(`renderElement.fromStart.${name}`, new Date - start);

	// We _also_ keep track of the _total_ time we spent rendering during
	// each request so we can keep track of that overhead.
	RLS().renderTime || (RLS().renderTime = 0);
	RLS().renderTime += individualTime;

	return html;
}

// Write as many elements out in a row as possible and then flush output.
// We render elements as their data becomes available, so they might fill in
// out-of-order.
function writeElements(res, elements) {

	var t0 = RLS().timingDataT0;

	// Pick up where we left off.
	var start = RLS().nextElement||(RLS().nextElement=0);

	for (var i = start; i < elements.length; RLS().nextElement = ++i){

		// If we haven't rendered the next element yet, we're done.
		if (elements[i] === ELEMENT_PENDING) break;

		// Got one!
		// Mark when we sent it.
		res.write(`<div data-triton-root-id=${i} data-triton-timing-offset="${
			new Date - t0
		}">${elements[i]}</div>`);

		// Free for GC.
		elements[i] = ELEMENT_ALREADY_WRITTEN;

		if (PageUtil.PageConfig.get('isFragment')) continue;

		if (i === RLS().atfCount - 1){

			// Okay, we've sent all of our above-the-fold HTML,
			// now we can let the client start waking nodes up.
			bootstrapClient(res)
			for (var j = 0; j <= i; j++){
				renderScriptsAsync([{ text: `__tritonNodeArrival(${j})` }], res)
			}
		} else if (i >= RLS().atfCount){

			// Let the client know it's there.
			renderScriptsAsync([{ text: `__tritonNodeArrival(${i})` }], res)
		}
	}

	// It may be a while before we render the next element, so if we just
	// wrote anything let's send it down right away.
	if (i !== start) flushRes(res);
}

function bootstrapClient(res) {
	var initialContext = {
		'TritonAgent.cache': TritonAgent.cache().dehydrate(),
	};

	res.expose(initialContext, 'InitialContext');
	res.expose(getNonInternalConfigs(), "Config");

	// Using naked `rfBootstrap()` instead of `window.rfBootstrap()`
	// because the browser's error message if it isn't defined is more
	// helpful this way.  With `window.rfBootstrap()` the error is just
	// "undefined is not a function".
	renderScriptsAsync([{
		text: `${res.locals.state};rfBootstrap();`,
	}], res);

	// This actually needs to happen _synchronously_ with this current
	// function to avoid letting responses slip in between.
	setupLateArrivals(res);
}

function setupLateArrivals(res) {
	var start = RLS().startTime;
	var notLoaded = TritonAgent.cache().getPendingRequests();

	// This is for reporting purposes.  We're going to log how many late
	// requests there were, but we won't actually emit the log line until
	// all of the requests have resolved.
	TritonAgent.cache().markLateRequests();

	notLoaded.forEach( pendingRequest => {
		pendingRequest.entry.whenDataReadyInternal().then( () => {
			logger.time("lateArrival", new Date - start);
			renderScriptsAsync([{
				text: `__tritonDataArrival(${
					JSON.stringify(pendingRequest.url)
				}, ${
					StringEscapeUtil.escapeForScriptTag(JSON.stringify(pendingRequest.entry.dehydrate()))
				});`,
			}], res);

		})
	});

	// TODO: maximum-wait-time-exceeded-so-cancel-pending-requests code
	var promises = notLoaded.map( result => result.entry.dfd.promise );
	RLS().lateArrivals = Q.allSettled(promises)
}

function wrapUpLateArrivals(){
	return RLS().lateArrivals;
}

function closeBody(req, res) {
	res.write("</div></body></html>");
	return Q();
}

function endResponse(req, res) {
	res.end();
	return Q();
}

function logRequestStats(req, res, context, start){
	var allRequests = TritonAgent.cache().getAllRequests()
	,   notLoaded   = TritonAgent.cache().getLateRequests()
	,   sock        = req.socket
	,   stash       = context.getServerStash()

	// The socket can be re-used for multiple requests with keep-alive.
	// Fortunately, until HTTP/2 rolls around, the requests over a given
	// socket will happen serially.  So we can just keep track of the
	// previous values for each socket and log the delta for a given
	// request.
	stash.bytesR = sock.bytesRead    - (sock._preR||(sock._preR=0));
	stash.bytesW = sock.bytesWritten - (sock._preW||(sock._preW=0));

	sock._preR += stash.bytesR;
	sock._preW += stash.bytesW;

	logger.gauge("countDataRequests", allRequests.length);
	logger.gauge("countLateArrivals", notLoaded.length, {hi: 1});
	logger.gauge("bytesRead", stash.bytesR, {hi: 1<<12});
	logger.gauge("bytesWritten", stash.bytesW, {hi: 1<<18});

	var time = new Date - start;

	logger.time(`responseCode.${res.statusCode}`, time);
	logger.time("totalRequestTime", time);

	// Only populated for full pages and fragments.
	if (RLS().renderTime){
		logger.time("totalRenderTime", RLS().renderTime);
	}

	if (notLoaded.length) {
		logger.time("totalRequestTimeWithLateArrivals", time);
	}

	return Q();
}

function getNonInternalConfigs() {
	var nonInternal = {};
	var fullConfig = config();
	Object.keys(fullConfig).forEach( configKey => {
		if (configKey !== 'internal') {
			nonInternal[configKey] = fullConfig[configKey];
		}
	});
	return nonInternal;
}
