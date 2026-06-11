/**
 * engineWorker.js — Chess Coach Mobile
 * Stockfish 18 Lite WASM Web Worker Bridge
 *
 * How stockfish-18-lite.js works in a Web Worker:
 *   - It exports a global function `f()` that, when called with a module config,
 *     returns a ready WASM module via Promise.
 *   - The module has:
 *       module.listener = (line) => { ... }   // called for every UCI output line
 *       module.processCommand(cmd)             // sends a UCI command
 *
 * Protocol (from game.js → this worker):
 *   { type: 'getMove',    fen: string, engineElo: number, depth: number }
 *   { type: 'getMultiPV', fen: string, multiPV: number, depth: number }
 *   { type: 'stop' }
 *   { type: 'newGame' }
 *
 * Protocol (from this worker → game.js):
 *   { type: 'ready' }
 *   { type: 'bestmove', move: string }
 *   { type: 'multiPVComplete', lines: Array, bestmove: string }
 *   { type: 'info', ... }
 *   { type: 'error', message: string }
 */

'use strict';

let sfModule      = null;   // The initialized WASM module
let isReady       = false;
let currentTask   = null;   // 'getMove' | 'getMultiPV'
let multiPVLines  = {};
let multiPVCount  = 1;
const pendingCmds = [];     // commands queued before engine ready

// ── Load Stockfish ──────────────────────────────────────────────
// The stockfish-18-lite.js file, when imported via importScripts,
// either:
//   A) Sets self.onmessage (worker-mode), OR
//   B) Exposes a global factory function (browser-mode)
// We force option B by providing a module config with a `listener` callback.

try {
  // Save current onmessage so we can restore our handler after import
  const ownHandler = self.onmessage;

  importScripts('./lib/stockfish.js');

  // After importScripts, check what happened:
  // stockfish.js in "worker mode" sets self.onmessage and uses postMessage for output
  // stockfish.js in "browser mode" exposes a global function (usually named `Stockfish` or `f`)

  initStockfishEngine();

} catch (e) {
  self.postMessage({ type: 'error', message: 'Failed to load stockfish.js: ' + e.message });
}

function initStockfishEngine() {
  // The stockfish-18-lite.js script when run in a web worker context
  // detects it's in a worker and goes into "worker mode" where it:
  //   1. Sets self.onmessage to receive UCI commands
  //   2. Calls postMessage to output UCI responses

  // We intercept postMessage to capture UCI output
  const realPostMessage = self.postMessage.bind(self);

  // Install our interceptor
  self.postMessage = function(data) {
    if (typeof data === 'string') {
      // This is a UCI output line from stockfish
      handleUCIOutput(data);
    } else {
      // Structured message going to game.js — pass through
      realPostMessage(data);
    }
  };

  // Install our message handler OVER stockfish's handler
  // We'll route commands from game.js through to stockfish's handler
  const sfMessageHandler = self.onmessage;

  // Forward game.js → this worker messages to stockfish's handler
  // while also handling our own protocol messages
  self.onmessage = function(event) {
    const msg = event.data;

    // If it's a plain string, forward directly to stockfish
    if (typeof msg === 'string') {
      if (sfMessageHandler) sfMessageHandler({ data: msg });
      return;
    }

    // Otherwise it's our structured protocol from game.js
    if (!msg || !msg.type) return;
    handleGameMessage(msg, sfMessageHandler, realPostMessage);
  };

  // If stockfish hasn't set its onmessage yet (it might be async),
  // wait a bit and retry
  if (!sfMessageHandler) {
    // Try to find the exposed factory function
    const factoryFn = self.Stockfish || self.f || self.stockfish;
    if (typeof factoryFn === 'function') {
      initViaFactory(factoryFn, realPostMessage);
    } else {
      // Wait for stockfish to set up its worker mode
      setTimeout(() => {
        const sfHandler = self.onmessage;
        if (sfHandler && sfHandler !== self.onmessage) {
          // stockfish installed its handler — we need to wrap it
          reinitWithHandler(sfHandler, realPostMessage);
        } else {
          realPostMessage({ type: 'error', message: 'Stockfish failed to initialize' });
        }
      }, 500);
    }
    return;
  }

  // stockfish's onmessage IS set — kick off UCI handshake
  sfMessageHandler({ data: 'uci' });
}

function reinitWithHandler(sfHandler, realPostMessage) {
  self.onmessage = function(event) {
    const msg = event.data;
    if (typeof msg === 'string') {
      sfHandler({ data: msg });
      return;
    }
    if (!msg || !msg.type) return;
    handleGameMessage(msg, sfHandler, realPostMessage);
  };
  sfHandler({ data: 'uci' });
}

// Alternative: Use factory function API if available
function initViaFactory(factoryFn, realPostMessage) {
  const config = {
    locateFile: (path) => {
      if (path.endsWith('.wasm')) return './lib/stockfish.wasm';
      return './lib/' + path;
    },
    print:    (line) => handleUCIOutput(line),
    printErr: (line) => console.warn('[Stockfish stderr]', line),
  };

  factoryFn(config).then((module) => {
    sfModule = module;

    // Wait for engine to be ready
    function checkReady() {
      if (module._isReady && !module._isReady()) {
        setTimeout(checkReady, 10);
        return;
      }
      // Setup listener for output
      module.listener = (line) => handleUCIOutput(line);
      // Engine is ready
      handleUCIOutput('readyok');
    }
    checkReady();

    // Install message handler using module.processCommand
    self.onmessage = function(event) {
      const msg = event.data;
      if (!msg || !msg.type) return;
      handleGameMessageViaModule(msg, module, realPostMessage);
    };

  }).catch(err => {
    realPostMessage({ type: 'error', message: 'Factory init failed: ' + err });
  });
}

// ── UCI Output Handler ──────────────────────────────────────────
function handleUCIOutput(line) {
  if (!line) return;

  if (line === 'uciok') {
    sendToEngine('isready');
    return;
  }

  if (line === 'readyok') {
    isReady = true;
    // Flush pending commands
    while (pendingCmds.length) sendToEngine(pendingCmds.shift());
    self.postMessage({ type: 'ready' });
    return;
  }

  if (line.startsWith('info') && line.includes(' pv ')) {
    const parsed = parseInfoLine(line);
    if (parsed) {
      self.postMessage({ type: 'info', ...parsed });
      if (currentTask === 'getMultiPV') {
        const key = parsed.multipv || 1;
        multiPVLines[key] = parsed;
      }
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    const parts = line.split(' ');
    const move  = parts[1] && parts[1] !== '(none)' ? parts[1] : null;

    if (currentTask === 'getMultiPV') {
      const lines = Object.values(multiPVLines)
        .sort((a, b) => (a.multipv || 1) - (b.multipv || 1));
      self.postMessage({ type: 'multiPVComplete', lines, bestmove: move });
      multiPVLines = {};
    } else {
      self.postMessage({ type: 'bestmove', move });
    }

    currentTask = null;
  }
}

// ── Send command to engine ──────────────────────────────────────
function sendToEngine(cmd) {
  if (sfModule && sfModule.processCommand) {
    sfModule.processCommand(cmd);
  } else {
    // Try via onmessage (worker-mode stockfish)
    // The current self.onmessage is our handler — we need stockfish's
    // We'll dispatch it as if it came from the main thread via an internal route
    _dispatchToStockfish(cmd);
  }
}

// Internal dispatch to stockfish's UCI command handler
let _stockfishDispatch = null;

function _dispatchToStockfish(cmd) {
  if (_stockfishDispatch) {
    _stockfishDispatch(cmd);
  } else {
    pendingCmds.push(cmd);
  }
}

// ── Parse UCI info line ─────────────────────────────────────────
function parseInfoLine(line) {
  const tokens = line.split(' ');
  const result = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth')    result.depth    = parseInt(tokens[++i]);
    if (t === 'seldepth') result.seldepth = parseInt(tokens[++i]);
    if (t === 'multipv')  result.multipv  = parseInt(tokens[++i]);
    if (t === 'nodes')    result.nodes    = parseInt(tokens[++i]);
    if (t === 'nps')      result.nps      = parseInt(tokens[++i]);
    if (t === 'time')     result.time     = parseInt(tokens[++i]);
    if (t === 'score') {
      const scoreType  = tokens[++i];
      const scoreValue = parseInt(tokens[++i]);
      result.score = { type: scoreType, value: scoreValue };
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') {
        result.score.bound = tokens[++i];
      }
    }
    if (t === 'pv') {
      result.pv       = tokens.slice(i + 1).join(' ');
      result.bestMove = tokens[i + 1] || null;
      break;
    }
  }

  return result.depth ? result : null;
}

// ── Handle game.js messages ─────────────────────────────────────
function handleGameMessage(msg, sfHandler, realPostMessage) {
  function send(cmd) {
    if (sfHandler) sfHandler({ data: cmd });
    else if (sfModule && sfModule.processCommand) sfModule.processCommand(cmd);
    else pendingCmds.push(cmd);
  }

  switch (msg.type) {
    case 'newGame':
      multiPVLines = {};
      currentTask  = null;
      if (isReady) {
        send('ucinewgame');
        send('isready');
      }
      break;

    case 'getMove': {
      if (!isReady) { realPostMessage({ type: 'error', message: 'Engine not ready' }); return; }
      currentTask  = 'getMove';
      multiPVLines = {};
      const elo    = msg.engineElo || 1500;
      const depth  = msg.depth || 16;
      send(`setoption name UCI_LimitStrength value true`);
      send(`setoption name UCI_Elo value ${elo}`);
      send(`setoption name MultiPV value 1`);
      send(`position fen ${msg.fen}`);
      send(`go depth ${depth}`);
      break;
    }

    case 'getMultiPV': {
      if (!isReady) { realPostMessage({ type: 'error', message: 'Engine not ready' }); return; }
      currentTask  = 'getMultiPV';
      multiPVLines = {};
      multiPVCount = msg.multiPV || 3;
      const depth  = msg.depth || 16;
      send(`setoption name UCI_LimitStrength value false`);
      send(`setoption name MultiPV value ${multiPVCount}`);
      send(`position fen ${msg.fen}`);
      send(`go depth ${depth}`);
      break;
    }

    case 'evaluate': {
      if (!isReady) return;
      currentTask  = 'getMultiPV';
      multiPVLines = {};
      multiPVCount = 1;
      send(`setoption name UCI_LimitStrength value false`);
      send(`setoption name MultiPV value 1`);
      send(`position fen ${msg.fen}`);
      send(`go depth ${msg.depth || 14}`);
      break;
    }

    case 'stop':
      send('stop');
      break;
  }
}

function handleGameMessageViaModule(msg, module, realPostMessage) {
  function send(cmd) { module.processCommand(cmd); }
  handleGameMessage(msg, null, realPostMessage);
}
