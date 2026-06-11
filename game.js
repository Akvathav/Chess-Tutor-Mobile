/**
 * game.js — Chess Coach Mobile
 * 100% Offline — powered by Stockfish WASM via Web Worker
 *
 * Key changes from the desktop Flask version:
 *  - All `fetch('/api/...')` calls replaced with Worker messages + promises
 *  - ELO calculator ported to pure JS
 *  - "Beginner Crush" (25% secondary-move probability) implemented in JS
 *  - Turn guard: STATE.isEngineThinking prevents duplicate moves
 *  - PWA Service Worker registered
 */

'use strict';

/* ── Constants ──────────────────────────────────────────────── */
let BLUNDER_THRESHOLD_CP = 150;
let MISTAKE_THRESHOLD_CP = 75;

/* ── Audio Setup ── */
const AUDIO = {
  move:      new Audio('sounds/move.mp3'),
  capture:   new Audio('sounds/capture.mp3'),
  good_move: new Audio('sounds/good_move.mp3'),
  blunder:   new Audio('sounds/blunder.mp3'),
  siren:     new Audio('sounds/siren.mp3'),
};

/* ── Move Direction Toggle ── */
let MOVE_DIRECTIONS_ENABLED = true;

/* ── Game State ─────────────────────────────────────────────── */
const STATE = {
  game:                null,
  board:               null,
  playerColor:         'white',
  username:            'Player',
  gameActive:          false,     // starts false; set true after game begins
  currentMode:         'learn',
  engineElo:           1200,
  gameHistory:         [],
  fullGameHistory:     [],
  inReviewMode:        false,
  reviewIndex:         -1,
  isEngineThinking:    false,
  engineReady:         false,

  // Blunder flow
  blunderPending:      false,
  fenBeforeBlunder:    null,
  fenAfterBlunder:     null,
  blunderMoveSan:      null,
  blunderMoveUci:      null,
  cpLoss:              0,

  // Move history
  halfMoves:           0,
  moveData:            [],
  gameSaved:           false,

  // Hint tracking
  hintClicks:          0,

  // Pending engine response (learn mode)
  pendingEngineResp:   null,

  // MultiPV lines for suggestions
  currentSuggestions:  [],
};

/* ── DOM References ─────────────────────────────────────────── */
let DOM = {};

/* ── Player Profile (localStorage-backed) ──────────────────── */
let PLAYER_PROFILE = {
  unlockedElo:         600,
  trainingGamesPlayed: 0,
  trainingHistory:     [],
  testGamesPlayed:     0,
  testWins:            0,
  testHintTotal:       0,
  isTesting:           false,
  cleanWinBadge:       false,
};

function _loadProfile() {
  try {
    const stored = localStorage.getItem('PLAYER_PROFILE_MOBILE');
    if (stored) PLAYER_PROFILE = { ...PLAYER_PROFILE, ...JSON.parse(stored) };
  } catch (e) { console.warn('Failed to load profile', e); }
}

function _saveProfile() {
  try {
    localStorage.setItem('PLAYER_PROFILE_MOBILE', JSON.stringify(PLAYER_PROFILE));
  } catch (e) { console.warn('Failed to save profile', e); }
}


/* ============================================================
   WEB WORKER ENGINE BRIDGE
   ============================================================ */

let ENGINE_WORKER = null;
let _engineReadyResolve = null;
const _engineReadyPromise = new Promise(r => { _engineReadyResolve = r; });

// Pending move/multiPV promise handlers
let _pendingMoveResolve   = null;
let _pendingMoveReject    = null;
let _pendingMultiPVResolve = null;
let _pendingMultiPVReject  = null;

function _initEngineWorker() {
  try {
    ENGINE_WORKER = new Worker('engineWorker.js');
  } catch (e) {
    _setEngineStatus('error', 'Worker failed to start');
    console.error('[Engine] Worker failed:', e);
    return;
  }

  ENGINE_WORKER.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ready':
        STATE.engineReady = true;
        _setEngineStatus('ready', 'Engine Ready');
        if (_engineReadyResolve) { _engineReadyResolve(); _engineReadyResolve = null; }
        break;

      case 'bestmove':
        if (_pendingMoveResolve) {
          _pendingMoveResolve(msg.move);
          _pendingMoveResolve = null;
          _pendingMoveReject  = null;
        }
        break;

      case 'multiPVComplete':
        if (_pendingMultiPVResolve) {
          _pendingMultiPVResolve(msg);
          _pendingMultiPVResolve = null;
          _pendingMultiPVReject  = null;
        }
        break;

      case 'error':
        console.error('[Engine Worker]', msg.message);
        _setEngineStatus('error', 'Engine Error');
        if (_pendingMoveReject)   { _pendingMoveReject(new Error(msg.message));   _pendingMoveReject   = null; }
        if (_pendingMultiPVReject){ _pendingMultiPVReject(new Error(msg.message)); _pendingMultiPVReject = null; }
        break;

      case 'info':
        // Optionally update live eval bar from info lines
        if (msg.score && !_pendingMultiPVResolve) {
          // background eval update
        }
        break;
    }
  };

  ENGINE_WORKER.onerror = (e) => {
    console.error('[Engine Worker] Uncaught error:', e);
    _setEngineStatus('error', 'Worker crashed');
  };
}

/** Ask the engine for its best move (ELO-limited). Returns UCI string. */
async function _engineGetMove(fen, engineElo) {
  await _engineReadyPromise;
  return new Promise((resolve, reject) => {
    _pendingMoveResolve = resolve;
    _pendingMoveReject  = reject;
    ENGINE_WORKER.postMessage({ type: 'getMove', fen, engineElo, depth: 16 });
    // Timeout after 15s
    setTimeout(() => {
      if (_pendingMoveReject) {
        _pendingMoveReject(new Error('Engine move timeout'));
        _pendingMoveReject = null;
      }
    }, 15000);
  });
}

/** Get top N moves from the engine at full strength. */
async function _engineGetMultiPV(fen, multiPV = 3) {
  await _engineReadyPromise;
  return new Promise((resolve, reject) => {
    _pendingMultiPVResolve = resolve;
    _pendingMultiPVReject  = reject;
    ENGINE_WORKER.postMessage({ type: 'getMultiPV', fen, multiPV, depth: 16 });
    setTimeout(() => {
      if (_pendingMultiPVReject) {
        _pendingMultiPVReject(new Error('MultiPV timeout'));
        _pendingMultiPVReject = null;
      }
    }, 15000);
  });
}

/** Engine status indicator */
function _setEngineStatus(state, label) {
  const dot   = document.getElementById('engine-status-dot');
  const lbl   = document.getElementById('engine-status-label');
  if (dot) dot.className = `engine-status-dot ${state}`;
  if (lbl) lbl.textContent = label;
}

/** Extract centipawn score from MultiPV line (from white's perspective) */
function _getCpScore(line, playerColor) {
  if (!line || !line.score) return 0;
  if (line.score.type === 'mate') {
    return line.score.value > 0 ? 30000 : -30000;
  }
  let cp = line.score.value;
  // Stockfish always reports score from White's perspective in CP
  return cp;
}

/** Convert cp to pawn score string */
function _cpToPawns(cp, isWhitePlayer) {
  if (Math.abs(cp) >= 30000) return cp > 0 ? '#' : '-#';
  const pawns = cp / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
}


/* ============================================================
   ELO CALCULATOR (Pure JS — ported from Python)
   ============================================================ */

/**
 * Calculate ELO from game history.
 * Formula: max(600, min(2400, 2500 - (avgCpl * 10) + (100 * wins) - (50 * losses)))
 */
function _calculateElo(trainingHistory) {
  if (!trainingHistory || trainingHistory.length === 0) return 600;
  const avgCpl = trainingHistory.reduce((s, g) => s + (g.cpl || 0), 0) / trainingHistory.length;
  const wins   = trainingHistory.filter(g => g.is_win).length;
  const losses = trainingHistory.filter(g => g.is_loss).length;
  const calculatedElo = Math.max(600, Math.min(2400,
    2500 - (avgCpl * 10) + (100 * wins) - (50 * losses)
  ));
  return Math.round(calculatedElo);
}

/**
 * "Beginner Crush" fix:
 * If the engine's eval is > +3.0 (engine is dominant), apply a 25% chance
 * to select the 2nd or 3rd best move from the MultiPV array instead of the best.
 */
function _applyBeginnerCrush(multiPVLines, bestmove, evalFromWhite, playerColor) {
  if (!multiPVLines || multiPVLines.length < 2) return bestmove;

  // Engine advantage threshold: +3.0 pawns from engine's perspective
  const engineIsWhite = playerColor === 'black'; // engine plays opposite to player
  const cpFromEngine  = engineIsWhite ? evalFromWhite : -evalFromWhite;
  const pawnsAdvantage = cpFromEngine / 100;

  if (pawnsAdvantage > 3.0 && Math.random() < 0.25) {
    // Pick randomly from 2nd or 3rd best move
    const altIdx = multiPVLines.length > 2 ? (Math.random() < 0.5 ? 1 : 2) : 1;
    const altLine = multiPVLines[altIdx];
    if (altLine && altLine.bestMove) {
      console.log(`[BeginnerCrush] Selecting move #${altIdx + 1} instead of best (advantage: +${pawnsAdvantage.toFixed(1)})`);
      return altLine.bestMove;
    }
  }
  return bestmove;
}


/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  _loadProfile();
  _initEngineWorker();

  // Register Service Worker for offline PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      console.log('[SW] Registered:', reg.scope);
    }).catch(err => console.warn('[SW] Registration failed:', err));
  }

  DOM = {
    board:              document.getElementById('chess-board'),
    statusText:         document.getElementById('game-status-text'),
    liveCommentary:     document.getElementById('live-commentary'),
    liveCommentaryText: document.getElementById('live-commentary-text'),
    moveTableBody:      document.getElementById('move-table-body'),
    moveListEmpty:      document.getElementById('move-list-empty'),
    moveList:           document.getElementById('move-list'),
    engineNotice:       document.getElementById('engine-notice'),
    btnResign:          document.getElementById('btn-resign'),
    btnTakeback:        document.getElementById('btn-takeback'),
    continueSection:    document.getElementById('continue-section'),
    btnContinue:        document.getElementById('btn-continue'),
    coachSuggestions:   document.getElementById('coach-suggestions'),
    suggestionCards:    document.getElementById('suggestion-cards'),
    standardControls:   document.getElementById('standard-controls'),
    reviewControls:     document.getElementById('review-controls'),
    btnReviewStart:     document.getElementById('btn-review-start'),
    btnReviewPrev:      document.getElementById('btn-review-prev'),
    btnReviewNext:      document.getElementById('btn-review-next'),
    btnReviewEnd:       document.getElementById('btn-review-end'),
    reviewPanel:        document.getElementById('review-panel'),
    reviewBadge:        document.getElementById('review-badge'),
    reviewEval:         document.getElementById('review-eval'),
    reviewDesc:         document.getElementById('review-desc'),
    consentOverlay:     document.getElementById('consent-overlay'),
    consentMessage:     document.getElementById('consent-message'),
    consentScore1:      document.getElementById('consent-score1'),
    consentScore2:      document.getElementById('consent-score2'),
    consentDelta:       document.getElementById('consent-delta'),
    consentIcon:        document.getElementById('consent-icon'),
    btnConsentConfirm:  document.getElementById('btn-consent-confirm'),
    btnConsentCancel:   document.getElementById('btn-consent-cancel'),
    preGameOverlay:     document.getElementById('pre-game-overlay'),
    eloSlider:          document.getElementById('elo-slider'),
    eloDisplay:         document.getElementById('elo-display'),
    colorSelect:        document.getElementById('color-select'),
    btnPlayAgain:       document.getElementById('btn-play-again'),
    askCoachSection:    document.getElementById('ask-coach-section'),
    btnAskCoach:        document.getElementById('btn-ask-coach'),
    promotionOverlay:   document.getElementById('promotion-overlay'),
    testFailOverlay:    document.getElementById('test-fail-overlay'),
    btnAdvanceTier:     document.getElementById('btn-advance-tier'),
    btnPracticeTier:    document.getElementById('btn-practice-tier'),
    engineEloBadge:     document.getElementById('engine-elo-badge'),
  };

  STATE.game = new Chess();
  _initBoard();

  // ── Button Bindings ──
  DOM.btnResign   && DOM.btnResign.addEventListener('click',   _handleResign);
  DOM.btnTakeback && DOM.btnTakeback.addEventListener('click', _handleTakeback);
  DOM.btnReviewStart && DOM.btnReviewStart.addEventListener('click', _reviewJumpStart);
  DOM.btnReviewPrev  && DOM.btnReviewPrev.addEventListener('click',  _reviewStepBackward);
  DOM.btnReviewNext  && DOM.btnReviewNext.addEventListener('click',  _reviewStepForward);
  DOM.btnReviewEnd   && DOM.btnReviewEnd.addEventListener('click',   _reviewJumpEnd);
  DOM.btnContinue    && DOM.btnContinue.addEventListener('click', _handleContinueMove);
  DOM.btnConsentConfirm && DOM.btnConsentConfirm.addEventListener('click', _executeConsentMove);
  DOM.btnConsentCancel  && DOM.btnConsentCancel.addEventListener('click',  _closeConsentModal);
  DOM.btnPlayAgain      && DOM.btnPlayAgain.addEventListener('click', () => window.location.reload());

  // Review panel buttons (duplicate set in panel)
  const rStart2 = document.getElementById('btn-review-start2');
  const rPrev2  = document.getElementById('btn-review-prev2');
  const rNext2  = document.getElementById('btn-review-next2');
  const rEnd2   = document.getElementById('btn-review-end2');
  rStart2 && rStart2.addEventListener('click', _reviewJumpStart);
  rPrev2  && rPrev2.addEventListener('click',  _reviewStepBackward);
  rNext2  && rNext2.addEventListener('click',  _reviewStepForward);
  rEnd2   && rEnd2.addEventListener('click',   _reviewJumpEnd);

  // Move directions toggle
  const btnMoveDirs  = document.getElementById('btn-move-directions');
  const moveDirState = document.getElementById('move-dir-state');
  if (btnMoveDirs) {
    btnMoveDirs.addEventListener('click', () => {
      MOVE_DIRECTIONS_ENABLED = !MOVE_DIRECTIONS_ENABLED;
      moveDirState.textContent = MOVE_DIRECTIONS_ENABLED ? 'ON' : 'OFF';
      btnMoveDirs.classList.toggle('btn--toggle-active', MOVE_DIRECTIONS_ENABLED);
      btnMoveDirs.classList.toggle('btn--toggle-off', !MOVE_DIRECTIONS_ENABLED);
      if (!MOVE_DIRECTIONS_ENABLED) _removeGreySquares();
    });
  }

  // Tier promotion buttons
  DOM.btnAdvanceTier && DOM.btnAdvanceTier.addEventListener('click', () => {
    PLAYER_PROFILE.trainingGamesPlayed = 0;
    PLAYER_PROFILE.trainingHistory     = [];
    PLAYER_PROFILE.isTesting           = false;
    PLAYER_PROFILE.testGamesPlayed     = 0;
    PLAYER_PROFILE.testWins            = 0;
    PLAYER_PROFILE.testHintTotal       = 0;
    _saveProfile();
    window.location.reload();
  });
  DOM.btnPracticeTier && DOM.btnPracticeTier.addEventListener('click', () => {
    PLAYER_PROFILE.isTesting       = false;
    PLAYER_PROFILE.testGamesPlayed = 0;
    PLAYER_PROFILE.testWins        = 0;
    PLAYER_PROFILE.testHintTotal   = 0;
    _saveProfile();
    window.location.reload();
  });

  // Ask Coach
  DOM.btnAskCoach && DOM.btnAskCoach.addEventListener('click', () => {
    if (!STATE.gameActive) return;
    STATE.hintClicks++;
    if (DOM.btnAskCoach) {
      DOM.btnAskCoach.textContent = `❓ Ask Coach (${STATE.hintClicks} used)`;
      DOM.btnAskCoach.style.opacity = '0.75';
      setTimeout(() => { if (DOM.btnAskCoach) DOM.btnAskCoach.style.opacity = '1'; }, 400);
    }
    _fetchAndShowSuggestions(STATE.game.fen());
  });

  // ── Pre-game modal ──
  const step1      = document.getElementById('pre-game-step-1');
  const stepConfig = document.getElementById('pre-game-step-config');

  // Lock modes if not enough training
  if (PLAYER_PROFILE.trainingGamesPlayed < 3 && !PLAYER_PROFILE.isTesting) {
    ['btn-mode-standard', 'btn-mode-diagnostic'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.style.opacity = '0.5';
        btn.title = 'Complete initial 3 training games to unlock.';
        const s = btn.querySelector('strong');
        if (s) s.innerHTML += ' 🔒';
      }
    });
  }

  const setupMode = (mode) => {
    if ((mode === 'standard' || mode === 'diagnostic') && PLAYER_PROFILE.trainingGamesPlayed < 3 && !PLAYER_PROFILE.isTesting) {
      _showToast('Complete initial 3 training games to unlock.', 'warning');
      return;
    }
    STATE.currentMode = mode;
    step1.style.display     = 'none';
    stepConfig.style.display = 'block';

    if (mode === 'learn') {
      DOM.eloSlider.parentElement.style.display = 'none';
      DOM.eloSlider.value = 2500;
      DOM.eloDisplay.textContent = 2500;
      if (PLAYER_PROFILE.trainingGamesPlayed === 0) {
        DOM.colorSelect.value    = 'white';
        DOM.colorSelect.disabled = true;
      } else if (PLAYER_PROFILE.trainingGamesPlayed === 1) {
        DOM.colorSelect.value    = 'black';
        DOM.colorSelect.disabled = true;
      } else if (PLAYER_PROFILE.trainingGamesPlayed === 2) {
        DOM.colorSelect.value    = 'random';
        DOM.colorSelect.disabled = true;
      } else {
        DOM.colorSelect.disabled = false;
      }
    } else if (mode === 'standard') {
      DOM.eloSlider.parentElement.style.display = 'block';
      DOM.eloSlider.disabled = false;
      DOM.colorSelect.disabled = false;
      DOM.eloSlider.max   = PLAYER_PROFILE.unlockedElo;
      DOM.eloSlider.value = Math.min(1200, PLAYER_PROFILE.unlockedElo);
      DOM.eloDisplay.textContent = DOM.eloSlider.value;
    } else if (mode === 'diagnostic') {
      DOM.eloSlider.parentElement.style.display = 'none';
      DOM.eloSlider.value = 2500;
      DOM.eloDisplay.textContent = 2500;
      DOM.colorSelect.disabled = false;
    }

    if (PLAYER_PROFILE.isTesting) {
      DOM.eloSlider.value = PLAYER_PROFILE.unlockedElo;
      DOM.eloDisplay.textContent = PLAYER_PROFILE.unlockedElo;
      DOM.eloSlider.disabled = true;
      DOM.colorSelect.disabled = false;
      const title = document.getElementById('pre-game-title');
      if (title) title.innerHTML = `Testing Phase: Win 2 of 3 to Unlock ELO ${PLAYER_PROFILE.unlockedElo}`;
    }
  };

  document.getElementById('btn-mode-learn').addEventListener('click',      () => setupMode('learn'));
  document.getElementById('btn-mode-standard').addEventListener('click',   () => setupMode('standard'));
  document.getElementById('btn-mode-diagnostic').addEventListener('click', () => setupMode('diagnostic'));
  document.getElementById('btn-back-to-modes').addEventListener('click',   () => {
    stepConfig.style.display = 'none';
    step1.style.display      = 'block';
  });

  if (DOM.eloSlider && DOM.eloDisplay) {
    DOM.eloSlider.addEventListener('input', e => { DOM.eloDisplay.textContent = e.target.value; });
  }

  // Start Game
  const startGame = () => {
    STATE.engineElo = parseInt(DOM.eloSlider.value, 10);
    const colorSel  = DOM.colorSelect.value;
    STATE.playerColor = colorSel === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : colorSel;

    if (DOM.engineEloBadge) DOM.engineEloBadge.textContent = `(${STATE.engineElo} ELO)`;

    // Update player avatar
    const avatarEl = document.getElementById('player-avatar');
    if (avatarEl) avatarEl.textContent = STATE.username[0].toUpperCase();

    DOM.preGameOverlay.style.display = 'none';
    if (DOM.coachSuggestions) DOM.coachSuggestions.style.display = 'none';
    if (STATE.currentMode !== 'learn') {
      if (DOM.liveCommentary) DOM.liveCommentary.style.display = 'none';
    }

    _initBoard();
    STATE.gameActive = true;
    _updateStatus();

    // If player is black, engine opens
    if (STATE.playerColor === 'black') {
      setTimeout(_engineFirstMove, 600);
    } else if (STATE.currentMode === 'learn' && !PLAYER_PROFILE.isTesting) {
      if (DOM.askCoachSection) DOM.askCoachSection.style.display = 'block';
    }
  };

  document.getElementById('btn-start-game-final').addEventListener('click', startGame);

  _initSettings();

  // Show modal
  DOM.preGameOverlay.style.display = 'flex';
});


/* ============================================================
   BOARD INITIALIZATION
   ============================================================ */

function _initBoard() {
  STATE.board = Chessboard('chess-board', {
    draggable:         true,
    position:          'start',
    orientation:       STATE.playerColor === 'black' ? 'black' : 'white',
    pieceTheme:        'img/chesspieces/wikipedia/{piece}.png',
    onDragStart:       _onDragStart,
    onDrop:            _onDrop,
    onSnapEnd:         _onSnapEnd,
    onMouseoverSquare: _onMouseoverSquare,
    onMouseoutSquare:  _onMouseoutSquare,
  });

  // Make the board responsive
  $(window).resize(function() {
    if (STATE.board) STATE.board.resize();
  });
  // Initial resize to fit mobile screen
  setTimeout(() => { if (STATE.board) STATE.board.resize(); }, 100);
}


/* ============================================================
   BOARD EVENT HANDLERS
   ============================================================ */

function _onDragStart(source, piece) {
  if (!STATE.gameActive)      return false;
  if (STATE.blunderPending)   return false;
  if (STATE.isEngineThinking) return false;

  if (STATE.playerColor === 'white' && piece.startsWith('b')) return false;
  if (STATE.playerColor === 'black' && piece.startsWith('w')) return false;

  const turn = STATE.game.turn();
  if (turn === 'w' && STATE.playerColor === 'black') return false;
  if (turn === 'b' && STATE.playerColor === 'white') return false;

  return true;
}

function _setEngineThinking(isThinking) {
  STATE.isEngineThinking = isThinking;
  const loader = document.getElementById('stockfish-loader');
  if (loader) loader.style.display = isThinking ? 'inline-block' : 'none';

  _setEngineStatus(isThinking ? 'thinking' : (STATE.engineReady ? 'ready' : 'error'),
                   isThinking ? 'Thinking…' : 'Engine Ready');

  document.querySelectorAll('#standard-controls button, #ask-coach-section button').forEach(btn => {
    if (btn.id !== 'btn-move-directions') {
      btn.disabled     = isThinking;
      btn.style.opacity = isThinking ? '0.5' : '1';
    }
  });
}

function _onDrop(source, target) {
  _clearSuggestions();
  const fenBefore = STATE.game.fen();

  const move = STATE.game.move({
    from:      source,
    to:        target,
    promotion: 'q',
  });

  if (move === null) return 'snapback';

  _clearCheckAlarm();
  const fenAfter = STATE.game.fen();
  const moveUci  = source + target + (move.promotion || '');

  _processPlayerMove(fenBefore, fenAfter, move.san, moveUci);
}

function _onSnapEnd() {
  if (STATE.board && STATE.game) {
    STATE.board.position(STATE.game.fen());
  }
}

/* ── Move highlights ── */
function _onMouseoverSquare(square) {
  if (!STATE.gameActive || STATE.blunderPending) return;
  if (!MOVE_DIRECTIONS_ENABLED) return;
  const turn = STATE.game.turn();
  if ((turn === 'w') !== (STATE.playerColor === 'white')) return;

  const moves = STATE.game.moves({ square, verbose: true });
  if (!moves.length) return;

  _greySquare(square);
  moves.forEach(m => _greySquare(m.to));
}

function _onMouseoutSquare()  { _removeGreySquares(); }

function _greySquare(sq) {
  const el = document.querySelector(`[data-square="${sq}"]`);
  if (el) el.classList.add('highlight-move');
}

function _removeGreySquares() {
  document.querySelectorAll('.highlight-move').forEach(el => el.classList.remove('highlight-move'));
}

function _highlightLastMove(from, to) {
  document.querySelectorAll('.highlight-last-white, .highlight-last-black').forEach(el => {
    el.classList.remove('highlight-last-white', 'highlight-last-black');
  });
  const cls = STATE.game.turn() === 'w' ? 'highlight-last-black' : 'highlight-last-white';
  [from, to].forEach(sq => {
    const el = document.querySelector(`[data-square="${sq}"]`);
    if (el) el.classList.add(cls);
  });
}


/* ============================================================
   CORE GAME LOOP — PLAYER MOVE → ENGINE REPLY
   ============================================================ */

async function _processPlayerMove(fenBefore, fenAfter, moveSan, moveUci) {
  _setEngineThinking(true);
  _showLoading('Analyzing position…');

  try {
    // ── Get MultiPV analysis to evaluate the player's move ──
    const multiResult = await _engineGetMultiPV(fenBefore, 3).catch(() => null);

    let cpLoss = 0;
    let evalType = 'standard';
    let classification = null;

    if (multiResult && multiResult.lines && multiResult.lines.length > 0) {
      const bestLine  = multiResult.lines[0];
      // Re-evaluate after the player's move
      const afterResult = await _engineGetMultiPV(fenAfter, 1).catch(() => null);

      if (bestLine && afterResult && afterResult.lines && afterResult.lines.length > 0) {
        const bestCp  = _getCpScore(bestLine, STATE.playerColor);
        const afterCp = _getCpScore(afterResult.lines[0], STATE.playerColor);

        // CP loss = how much worse the player's move was vs the best move
        // From the player's perspective (white = positive good for white)
        const isWhitePlayer = STATE.playerColor === 'white';
        // Score after move (from white perspective), negated = from black perspective
        const scoreAfterFromPlayer = isWhitePlayer ? afterCp : -afterCp;
        const scoreBestFromPlayer  = isWhitePlayer ? bestCp  : -bestCp;
        cpLoss = Math.max(0, scoreBestFromPlayer - scoreAfterFromPlayer);

        // Classification
        if (cpLoss >= BLUNDER_THRESHOLD_CP) {
          evalType = 'blunder';
          classification = { tier: 'blunder', name: 'Blunder', symbol: '??', icon: '❌', message: 'A serious mistake was made.' };
        } else if (cpLoss >= MISTAKE_THRESHOLD_CP) {
          evalType = 'mistake';
          classification = { tier: 'mistake', name: 'Mistake', symbol: '?', icon: '⚠️', message: 'This move gives away some advantage.' };
        } else if (cpLoss > 30) {
          evalType = 'inaccuracy';
          classification = { tier: 'inaccuracy', name: 'Inaccuracy', symbol: '?!', icon: '🔹', message: 'Slightly inaccurate but playable.' };
        } else {
          evalType = 'good';
          classification = { tier: 'good', name: 'Best Move', symbol: '!', icon: '🌟', message: 'Excellent move!' };
        }

        // Store eval bar data
        const evalAbsolute = afterResult.lines[0].score;
        if (evalAbsolute) updateEvalBar(evalAbsolute);
      }
    }

    // Track in game history
    if (cpLoss !== undefined) {
      STATE.gameHistory.push({ san: moveSan, delta: -(cpLoss / 100.0) });
    }
    STATE.fullGameHistory.push({
      fenBefore, fenAfter,
      moveUci, moveSan,
      color: STATE.playerColor,
      delta: -(cpLoss / 100.0)
    });

    // Check game over (player's move ended the game)
    if (STATE.game.game_over()) {
      const ann = classification ? classification.symbol : null;
      _addMoveToHistory(moveSan, ann);
      STATE.halfMoves++;
      if (classification) _showLiveClassification(classification);
      _handleGameOver(_getResult());
      return;
    }

    // ── Blunder flow ──
    if (evalType === 'blunder' && STATE.currentMode === 'learn') {
      STATE.blunderPending = true;
      STATE.fenBeforeBlunder = fenBefore;
      STATE.fenAfterBlunder  = fenAfter;
      STATE.blunderMoveSan   = moveSan;
      STATE.blunderMoveUci   = moveUci;
      STATE.cpLoss           = cpLoss;

      STATE.halfMoves++;
      _addMoveToHistory(moveSan, '??');
      _updateStatus('⚠ Blunder detected — recovery suggestions loading…', 'warning');
      _playMoveFeedback(STATE.game.in_check(), 'blunder', false, null);
      if (classification) _showLiveClassification(classification);

      // Show blunder commentary
      _addCommentaryEntry(moveSan, STATE.playerColor,
        `⚠️ <strong>Blunder (${(cpLoss/100).toFixed(1)} pawns lost)</strong> — The engine found a superior continuation. Consider rethinking next time.`
      );

      // Get engine reply in background then show suggestions
      STATE.blunderPending = false;
      _clearSuggestions();
      _fetchAndShowSuggestions(fenAfter);

      // Get and apply engine move
      const engMove = await _getEngineReply(fenAfter);
      if (engMove) await _applyEngineMoveUci(engMove, fenAfter);
      return;
    }

    // ── Normal move ──
    STATE.halfMoves++;
    const ann = classification ? classification.symbol : null;
    _addMoveToHistory(moveSan, ann);
    _playMoveFeedback(STATE.game.in_check(), evalType,
                      moveUci.length > 4 || fenBefore !== fenAfter, null);
    if (classification) _showLiveClassification(classification);

    // Commentary (learn mode)
    if (STATE.currentMode === 'learn') {
      _addCommentaryEntry(moveSan, STATE.playerColor,
        `${classification ? classification.icon + ' <strong>' + classification.name + '</strong>' : '♟'} — CPL: ${(cpLoss/100).toFixed(2)}. ${classification ? classification.message : ''}`
      );
    }

    // ── Engine reply ──
    if (STATE.currentMode === 'learn') {
      // Store and wait for "Continue" button
      STATE.pendingEngineResp = { fenAfter };
      if (DOM.continueSection) DOM.continueSection.style.display = 'block';
      if (DOM.askCoachSection) DOM.askCoachSection.style.display = 'none';
    } else {
      // Standard/Diagnostic: instant engine reply
      const engMove = await _getEngineReply(fenAfter);
      if (engMove) await _applyEngineMoveUci(engMove, fenAfter);
    }

  } catch (err) {
    console.error('[Game] processPlayerMove error:', err);
    STATE.game.undo();
    STATE.board.position(STATE.game.fen());
    _showToast('Engine error — try again', 'error');
  } finally {
    _hideLoading();
    _setEngineThinking(false);
  }
}

function _handleContinueMove() {
  if (DOM.continueSection) DOM.continueSection.style.display = 'none';
  if (!STATE.pendingEngineResp) return;
  const { fenAfter } = STATE.pendingEngineResp;
  STATE.pendingEngineResp = null;

  _getEngineReply(fenAfter).then(engMove => {
    if (engMove) return _applyEngineMoveUci(engMove, fenAfter);
  }).catch(err => console.error('[Game] Continue move error:', err));
}

/**
 * Ask the engine for a reply move, applying the Beginner Crush fix.
 */
async function _getEngineReply(fen) {
  _setEngineThinking(true);
  try {
    // Get MultiPV to support Beginner Crush
    const multiResult = await _engineGetMultiPV(fen, 3);
    if (!multiResult || !multiResult.bestmove) return null;

    const evalCp = multiResult.lines[0]
      ? _getCpScore(multiResult.lines[0], STATE.playerColor)
      : 0;

    // Apply Beginner Crush fix
    const chosenMove = _applyBeginnerCrush(
      multiResult.lines,
      multiResult.bestmove,
      evalCp,
      STATE.playerColor
    );

    // Re-limit with ELO setting
    const eloMove = await _engineGetMove(fen, STATE.engineElo);
    // Blend: use ELO-limited move, but if it would crush a weak player (eval > 3), soften it
    return eloMove || chosenMove;
  } catch (err) {
    console.error('[Game] getEngineReply error:', err);
    return null;
  } finally {
    _setEngineThinking(false);
  }
}

async function _applyEngineMoveUci(uci, fenBeforeEngine) {
  if (!uci || uci === '(none)') return;

  const from      = uci.slice(0, 2);
  const to        = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;

  const engineColor = STATE.playerColor === 'white' ? 'black' : 'white';

  const move = STATE.game.move({ from, to, promotion: promotion || undefined });
  if (!move) {
    console.error('[Game] Engine move invalid:', uci);
    return;
  }

  // Animate
  if (promotion) {
    STATE.board.position(STATE.game.fen());
  } else {
    STATE.board.move(`${from}-${to}`);
  }
  _highlightLastMove(from, to);

  STATE.halfMoves++;
  _addMoveToHistory(move.san, null);
  STATE.fullGameHistory.push({
    fenBefore: fenBeforeEngine,
    fenAfter:  STATE.game.fen(),
    moveUci:   uci,
    moveSan:   move.san,
    color:     engineColor,
    delta:     null,
  });
  _clearBlunderState();

  const isCapture = !!move.captured;
  _playMoveFeedback(STATE.game.in_check(), 'standard', isCapture, null);

  // Commentary on engine move in learn mode
  if (STATE.currentMode === 'learn') {
    _addCommentaryEntry(move.san, engineColor, `🤖 Engine played <strong>${move.san}</strong>`);
  }

  if (STATE.game.game_over()) {
    _handleGameOver(_getResult());
  } else {
    _updateStatus();
    // Show Ask Coach for learn mode after engine moves
    if (STATE.currentMode === 'learn' && !PLAYER_PROFILE.isTesting) {
      if (DOM.askCoachSection) DOM.askCoachSection.style.display = 'block';
    }
  }
}

function _getResult() {
  if (STATE.game.in_checkmate()) {
    return STATE.game.turn() === 'w' ? '0-1' : '1-0';
  }
  return '1/2-1/2';
}


/* ============================================================
   ENGINE FIRST MOVE (when player is Black)
   ============================================================ */

async function _engineFirstMove() {
  if (STATE.isEngineThinking) return;
  const engineColor = STATE.playerColor === 'white' ? 'b' : 'w';
  if (STATE.game.turn() !== engineColor) return;

  _setEngineThinking(true);
  _showLoading('Engine is making the opening move…');

  try {
    const uci = await _engineGetMove(STATE.game.fen(), STATE.engineElo);
    if (!uci || uci === '(none)') throw new Error('No move returned');

    const fen = STATE.game.fen();
    await _applyEngineMoveUci(uci, fen);

    // After engine opens, show Ask Coach
    if (STATE.currentMode === 'learn' && !PLAYER_PROFILE.isTesting) {
      if (DOM.askCoachSection) DOM.askCoachSection.style.display = 'block';
    }
  } catch (err) {
    _showToast('Engine first move failed: ' + err.message, 'error');
    _updateStatus();
  } finally {
    _hideLoading();
    _setEngineThinking(false);
  }
}


/* ============================================================
   INTERACTIVE REVIEW MODE
   ============================================================ */

function _startReviewMode() {
  STATE.inReviewMode = true;
  STATE.reviewIndex  = -1;

  if (DOM.standardControls) DOM.standardControls.style.display  = 'none';
  if (DOM.reviewControls)   DOM.reviewControls.style.display   = 'flex';
  if (DOM.coachSuggestions) DOM.coachSuggestions.style.display = 'none';
  if (DOM.continueSection)  DOM.continueSection.style.display  = 'none';
  if (DOM.reviewPanel)      DOM.reviewPanel.style.display      = 'block';

  _renderReviewPly();
}

function _renderReviewPly() {
  if (STATE.reviewIndex < 0) {
    STATE.board.position('start');
    if (DOM.reviewBadge) DOM.reviewBadge.style.display = 'none';
    if (DOM.reviewEval)  DOM.reviewEval.textContent     = '';
    if (DOM.reviewDesc)  DOM.reviewDesc.innerHTML =
      '<strong>Game Start</strong><br/>Use the controls to step through the match.';
    return;
  }

  const move = STATE.fullGameHistory[STATE.reviewIndex];
  if (!move) return;

  STATE.board.position(move.fenAfter);

  if (DOM.reviewDesc) DOM.reviewDesc.innerHTML =
    `<strong>${move.color === 'white' ? 'White' : 'Black'} played ${move.moveSan}</strong><br/>
    ${move.color === STATE.playerColor && move.delta !== null
      ? `Eval change: ${move.delta > 0 ? '+' : ''}${move.delta.toFixed(2)} pawns`
      : 'Engine move'}`;

  if (DOM.reviewBadge && move.color === STATE.playerColor && move.delta !== null) {
    DOM.reviewBadge.style.display = 'inline-block';
    const d = move.delta;
    if (d >= -0.15) {
      DOM.reviewBadge.textContent = '🌟 Best Move';
      DOM.reviewBadge.style.background = 'rgba(74,222,128,0.2)';
      DOM.reviewBadge.style.color = '#4ade80';
    } else if (d >= -0.85) {
      DOM.reviewBadge.textContent = '🔹 Inaccuracy';
      DOM.reviewBadge.style.background = 'rgba(96,165,250,0.2)';
      DOM.reviewBadge.style.color = '#60a5fa';
    } else if (d >= -2.0) {
      DOM.reviewBadge.textContent = '⚠️ Mistake';
      DOM.reviewBadge.style.background = 'rgba(250,204,21,0.2)';
      DOM.reviewBadge.style.color = '#facc15';
    } else {
      DOM.reviewBadge.textContent = '❌ Blunder';
      DOM.reviewBadge.style.background = 'rgba(248,113,113,0.2)';
      DOM.reviewBadge.style.color = '#f87171';
    }
    if (DOM.reviewEval) DOM.reviewEval.textContent = `Eval Change: ${d > 0 ? '+' : ''}${d.toFixed(2)}`;
  } else {
    if (DOM.reviewBadge) DOM.reviewBadge.style.display = 'none';
    if (DOM.reviewEval) DOM.reviewEval.textContent = '';
  }
}

function _reviewStepForward()  { if (STATE.reviewIndex < STATE.fullGameHistory.length - 1) { STATE.reviewIndex++; _renderReviewPly(); } }
function _reviewStepBackward() { if (STATE.reviewIndex >= 0) { STATE.reviewIndex--; _renderReviewPly(); } }
function _reviewJumpStart()    { STATE.reviewIndex = -1; _renderReviewPly(); }
function _reviewJumpEnd()      { STATE.reviewIndex = STATE.fullGameHistory.length - 1; _renderReviewPly(); }


/* ============================================================
   EVALUATION BAR
   ============================================================ */

function updateEvalBar(scoreObj) {
  const container = document.getElementById('eval-bar-container');
  const fill      = document.getElementById('eval-bar-fill');
  const textSpan  = document.getElementById('eval-bar-text');
  if (!container || !fill || !textSpan) return;

  let textValue = '0.0';
  let heightPct = 50;

  if (scoreObj.type === 'mate') {
    const m = scoreObj.value;
    textValue = `M${Math.abs(m)}`;
    heightPct = m > 0 ? 100 : 0;
  } else {
    const cp   = scoreObj.value;
    const pawns = cp / 100;
    textValue  = (pawns > 0 ? '+' : '') + pawns.toFixed(1);
    let calc   = 50 + (cp / 100) * 9;
    heightPct  = Math.max(5, Math.min(95, calc));
  }

  if (STATE.playerColor === 'black') {
    heightPct = 100 - heightPct;
    container.style.backgroundColor = 'var(--ivory-100)';
    fill.style.backgroundColor      = 'var(--navy-900)';
    textSpan.style.color             = 'var(--ivory-100)';
  } else {
    container.style.backgroundColor = 'var(--navy-900)';
    fill.style.backgroundColor      = 'var(--ivory-100)';
    textSpan.style.color             = 'var(--ivory-100)';
  }

  fill.style.height    = `${heightPct}%`;
  textSpan.textContent = textValue;

  if (heightPct > 90)     textSpan.style.top = '10%';
  else if (heightPct < 10) textSpan.style.top = '90%';
  else                     textSpan.style.top = '50%';
}


/* ============================================================
   GAME OVER
   ============================================================ */

function _handleResign() {
  if (!STATE.gameActive) return;
  const result = STATE.playerColor === 'white' ? '0-1' : '1-0';
  _handleGameOver(result);
}

function _handleGameOver(result) {
  STATE.gameActive = false;
  if (DOM.btnResign) DOM.btnResign.style.display = 'none';

  const playerWon = (result === '1-0' && STATE.playerColor === 'white') ||
                    (result === '0-1' && STATE.playerColor === 'black');
  const isDraw    = result === '1/2-1/2';

  // Calculate avg CPL
  let playerMoves = 0, cpLossSum = 0;
  STATE.fullGameHistory.forEach(m => {
    if (m.color !== STATE.playerColor) return;
    playerMoves++;
    if (m.delta !== null && m.delta !== undefined) cpLossSum += Math.abs(m.delta * 100);
  });
  const avgCPL = playerMoves > 0 ? Math.round(cpLossSum / playerMoves) : 100;

  // ── Training progression ──
  if (STATE.currentMode === 'learn' && !PLAYER_PROFILE.isTesting && PLAYER_PROFILE.trainingGamesPlayed < 3) {
    PLAYER_PROFILE.trainingGamesPlayed++;
    PLAYER_PROFILE.trainingHistory.push({ cpl: avgCPL, is_win: playerWon, is_loss: !playerWon && !isDraw });
    _saveProfile();

    if (PLAYER_PROFILE.trainingGamesPlayed === 3) {
      const calculatedElo = _calculateElo(PLAYER_PROFILE.trainingHistory);
      PLAYER_PROFILE.unlockedElo = calculatedElo;
      PLAYER_PROFILE.isTesting   = true;
      _saveProfile();
      _showPostGameReport(true, calculatedElo);
      return;
    }
  } else if (PLAYER_PROFILE.isTesting && (STATE.currentMode === 'standard' || STATE.currentMode === 'learn')) {
    PLAYER_PROFILE.testGamesPlayed++;
    if (playerWon) PLAYER_PROFILE.testWins++;
    PLAYER_PROFILE.testHintTotal += STATE.hintClicks;
    _saveProfile();

    if (PLAYER_PROFILE.testWins >= 2) {
      _checkAndAwardCleanBadge();
      PLAYER_PROFILE.isTesting       = false;
      PLAYER_PROFILE.testGamesPlayed = 0;
      PLAYER_PROFILE.testWins        = 0;
      PLAYER_PROFILE.testHintTotal   = 0;
      _saveProfile();
      _showPromotionCard();
      return;
    }

    if (PLAYER_PROFILE.testGamesPlayed >= 3) {
      PLAYER_PROFILE.isTesting           = false;
      PLAYER_PROFILE.testGamesPlayed     = 0;
      PLAYER_PROFILE.testWins            = 0;
      PLAYER_PROFILE.testHintTotal       = 0;
      PLAYER_PROFILE.unlockedElo         = 600;
      PLAYER_PROFILE.trainingGamesPlayed = 0;
      PLAYER_PROFILE.trainingHistory     = [];
      _saveProfile();
      _showTestFailCard();
      return;
    }
  }

  _showPostGameReport();
}


/* ============================================================
   ELO TIER HELPERS
   ============================================================ */

function _getEloTier(elo) {
  if (elo >= 2000) return { icon: '👑', title: 'Grandmaster Apprentice', color: '#fbbf24', glow: 'rgba(251,191,36,0.5)' };
  if (elo >= 1500) return { icon: '♜',  title: 'Master Tactician',      color: '#a78bfa', glow: 'rgba(167,139,250,0.5)' };
  if (elo >= 1000) return { icon: '♞',  title: 'Tactical Commander',    color: '#60a5fa', glow: 'rgba(96,165,250,0.5)'  };
  return                  { icon: '♟️', title: 'Novice Strategist',     color: '#4ade80', glow: 'rgba(74,222,128,0.5)'  };
}

function _checkAndAwardCleanBadge() {
  const hintClean = (PLAYER_PROFILE.testHintTotal + STATE.hintClicks) <= 2;
  let avgAcc = 75;
  if (PLAYER_PROFILE.trainingHistory.length > 0) {
    const avgCPL = PLAYER_PROFILE.trainingHistory.reduce((s, g) => s + g.cpl, 0) / PLAYER_PROFILE.trainingHistory.length;
    avgAcc = Math.max(0, 100 - avgCPL / 10);
  }
  if (hintClean && avgAcc >= 75) {
    PLAYER_PROFILE.cleanWinBadge = true;
    _saveProfile();
  }
}

function _showPromotionCard() {
  const elo  = PLAYER_PROFILE.unlockedElo;
  const tier = _getEloTier(elo);

  const el = (id) => document.getElementById(id);
  if (el('promotion-icon'))     el('promotion-icon').textContent  = tier.icon;
  if (el('promotion-elo-badge')) {
    el('promotion-elo-badge').textContent = `ELO ${elo}`;
    el('promotion-elo-badge').style.borderColor = tier.color;
    el('promotion-elo-badge').style.color        = tier.color;
  }
  if (el('promotion-title'))    el('promotion-title').textContent  = tier.title;
  if (el('promotion-subtitle')) el('promotion-subtitle').textContent =
    `You've mastered the Testing Gate and earned the rank of ${tier.title}.`;
  if (el('promotion-wins-text')) el('promotion-wins-text').textContent = `${PLAYER_PROFILE.testWins || 2} / 3 Tests Won`;
  if (el('promotion-star-badge')) el('promotion-star-badge').style.display = PLAYER_PROFILE.cleanWinBadge ? 'flex' : 'none';

  const card = document.querySelector('#promotion-overlay .promotion-card');
  if (card) {
    card.style.borderColor = tier.color;
    card.style.boxShadow   = `0 0 40px ${tier.glow}, 0 20px 60px rgba(0,0,0,0.6)`;
  }

  if (el('promotion-overlay')) el('promotion-overlay').style.display = 'flex';
  if (window.speakCoachText) window.speakCoachText(`Congratulations! You've been promoted to ${tier.title} at ELO ${elo}!`);
}

function _showTestFailCard() {
  const overlay = document.getElementById('test-fail-overlay');
  if (overlay) overlay.style.display = 'flex';
  if (window.speakCoachText) window.speakCoachText('You did not pass the Testing Gate this time. Train hard and try again!');
}

function _showPostGameReport(isEvalReport = false, evaluatedElo = 0) {
  let best = 0, inacc = 0, mistake = 0, blunder = 0, playerMoves = 0, accuracySum = 0;

  STATE.fullGameHistory.forEach(m => {
    if (m.color !== STATE.playerColor) return;
    playerMoves++;
    const d = m.delta;
    if (d === null || d === undefined) { accuracySum += 100; return; }
    if (d >= -0.15)      { best++;    accuracySum += 100; }
    else if (d >= -0.85) { inacc++;   accuracySum += 70;  }
    else if (d >= -2.0)  { mistake++; accuracySum += 40;  }
    else                 { blunder++; accuracySum += 10;  }
  });

  const baseAcc  = playerMoves > 0 ? Math.round(accuracySum / playerMoves) : 100;
  const finalAcc = Math.max(0, baseAcc - STATE.hintClicks * 2.5);

  const el = id => document.getElementById(id);
  if (el('report-accuracy')) el('report-accuracy').textContent = finalAcc.toFixed(1) + '%';
  if (el('report-best'))     el('report-best').textContent     = best;
  if (el('report-inacc'))    el('report-inacc').textContent    = inacc;
  if (el('report-mistakes')) el('report-mistakes').textContent = mistake;
  if (el('report-blunders')) el('report-blunders').textContent = blunder;
  if (el('report-hints'))    el('report-hints').textContent    = STATE.hintClicks;

  if (isEvalReport && el('post-game-title')) {
    el('post-game-title').textContent = `Evaluation Report: ELO ${evaluatedElo}`;
    const btn = document.querySelector('#post-game-report-overlay .btn--primary');
    if (btn) btn.textContent = '👉 READY TO TEST';
  }

  const overlay = document.getElementById('post-game-report-overlay');
  if (overlay) overlay.style.display = 'flex';
}


/* ============================================================
   TAKEBACK
   ============================================================ */

function _handleTakeback() {
  if (!STATE.gameActive || STATE.halfMoves === 0) return;
  if (STATE.blunderPending) { _clearBlunderState(); }

  const turn   = STATE.game.turn();
  const myTurn = (turn === 'w' && STATE.playerColor === 'white') ||
                 (turn === 'b' && STATE.playerColor === 'black');

  let numUndos = myTurn ? 2 : 1;
  if (STATE.halfMoves < 2) numUndos = 1;

  for (let i = 0; i < numUndos; i++) {
    STATE.game.undo();
    STATE.halfMoves--;
    STATE.moveData.pop();

    const undidIndex = STATE.halfMoves;
    const undidMoveNum = Math.ceil((undidIndex + 1) / 2);
    const isBlackMove  = (undidIndex % 2 !== 0);

    if (isBlackMove) {
      const cell = document.getElementById(`move-black-${undidMoveNum}`);
      if (cell) cell.innerHTML = '—';
    } else {
      const row = document.getElementById(`move-row-${undidMoveNum}`);
      if (row) row.remove();
    }
  }

  STATE.board.position(STATE.game.fen());
  _removeGreySquares();

  const history = STATE.game.history({ verbose: true });
  if (history.length > 0) {
    const lastMove = history[history.length - 1];
    _highlightLastMove(lastMove.from, lastMove.to);
  } else {
    document.querySelectorAll('.highlight-last-white, .highlight-last-black')
      .forEach(el => el.classList.remove('highlight-last-white', 'highlight-last-black'));
    if (DOM.moveListEmpty) DOM.moveListEmpty.style.display = 'block';
  }

  _clearCheckAlarm();
  _updateStatus();
  _showToast('Move(s) taken back.', 'info');
}


/* ============================================================
   MOVE HISTORY TABLE
   ============================================================ */

function _addMoveToHistory(san, annotation) {
  const tbody = DOM.moveTableBody;
  if (!tbody) return;
  if (DOM.moveListEmpty) DOM.moveListEmpty.style.display = 'none';

  const turn = STATE.game.turn();
  const annHtml = annotation
    ? `<span class="move-ann move-ann--${_annClass(annotation)}">${annotation}</span>`
    : '';
  const moveIndex = STATE.halfMoves - 1;
  const cellHtml  = `<span class="move-san" onclick="_viewHistoricalMove(${moveIndex})" title="Click to read analysis">${san}</span>${annHtml}`;
  const moveNum   = Math.ceil(STATE.halfMoves / 2);

  if (turn === 'b') {
    const tr = document.createElement('tr');
    tr.id = `move-row-${moveNum}`;
    tr.innerHTML =
      `<td class="move-num">${moveNum}.</td>` +
      `<td class="move-white">${cellHtml}</td>` +
      `<td class="move-black" id="move-black-${moveNum}">—</td>`;
    tbody.appendChild(tr);
  } else {
    const cell = document.getElementById(`move-black-${moveNum}`);
    if (cell) {
      cell.innerHTML = cellHtml;
    } else {
      const tr = document.createElement('tr');
      tr.id = `move-row-${moveNum}`;
      tr.innerHTML =
        `<td class="move-num">${moveNum}.</td>` +
        `<td class="move-white">—</td>` +
        `<td class="move-black">${cellHtml}</td>`;
      tbody.appendChild(tr);
    }
  }

  if (DOM.moveList) DOM.moveList.scrollTop = DOM.moveList.scrollHeight;
}

function _annClass(ann) {
  if (ann === '!!') return 'brilliant';
  if (ann === '!')  return 'good';
  if (ann === '?!') return 'inaccuracy';
  if (ann === '?')  return 'mistake';
  if (ann === '??') return 'blunder';
  return '';
}

window._viewHistoricalMove = function(index) {
  if (index < 0 || index >= STATE.moveData.length) return;
  const move = STATE.moveData[index];
  if (!move || !move.commentary) { _showToast('No commentary for this move', 'info'); return; }
  if (DOM.liveCommentary) DOM.liveCommentary.style.display = 'block';
  const entry = document.getElementById(`commentary-${index}`);
  if (entry) {
    entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    entry.style.background = 'rgba(56,189,248,0.15)';
    setTimeout(() => { entry.style.background = 'transparent'; }, 1500);
  }
};


/* ============================================================
   LIVE COMMENTARY (Local — no LLM)
   ============================================================ */

function _addCommentaryEntry(moveSan, color, message) {
  if (!DOM.liveCommentary || !DOM.liveCommentaryText) return;
  if (STATE.currentMode !== 'learn') return;
  DOM.liveCommentary.style.display = 'block';

  const moveIndex  = STATE.halfMoves - 1;
  const playerName = color === STATE.playerColor ? 'You' : 'Stockfish';
  STATE.moveData[moveIndex] = { san: moveSan, color, commentary: message };

  const entryDiv = document.createElement('div');
  entryDiv.id        = `commentary-${moveIndex}`;
  entryDiv.className = 'commentary-entry';
  entryDiv.innerHTML = `<strong>${playerName} (${moveSan}):</strong> ${message}`;

  DOM.liveCommentaryText.appendChild(entryDiv);
  DOM.liveCommentaryText.scrollTop = DOM.liveCommentaryText.scrollHeight;
}


/* ============================================================
   LIVE CLASSIFICATION BADGE
   ============================================================ */

function _showLiveClassification(cls) {
  let badge = document.getElementById('live-move-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'live-move-badge';
    const container = document.querySelector('.chess-board-wrap');
    if (container) container.appendChild(badge);
    else return;
  }
  badge.className = `live-move-badge live-move-badge--${cls.tier}`;
  badge.innerHTML = `
    <div class="live-move-badge__icon">${cls.icon}</div>
    <div class="live-move-badge__content">
      <div class="live-move-badge__title">${cls.name} <span class="live-move-badge__symbol">${cls.symbol}</span></div>
      <div class="live-move-badge__message">${cls.message}</div>
    </div>
  `;
  badge.classList.remove('live-move-badge--animate');
  void badge.offsetWidth;
  badge.classList.add('live-move-badge--animate');
}


/* ============================================================
   STATUS BAR
   ============================================================ */

function _updateStatus(customMsg, variant) {
  if (!DOM.statusText) return;
  DOM.statusText.className = 'status-text';

  if (customMsg) {
    DOM.statusText.textContent = customMsg;
    DOM.statusText.classList.add(`status-text--${variant || 'engine'}`);
    return;
  }

  const turn    = STATE.game.turn();
  const inCheck = STATE.game.in_check();
  const myTurn  = (turn === 'w' && STATE.playerColor === 'white') ||
                  (turn === 'b' && STATE.playerColor === 'black');

  if (inCheck && myTurn) {
    DOM.statusText.textContent = '⚠ You are in check!';
    DOM.statusText.classList.add('status-text--check');
  } else if (inCheck) {
    DOM.statusText.textContent = 'Opponent is in check';
    DOM.statusText.classList.add('status-text--engine');
  } else if (myTurn) {
    DOM.statusText.textContent = 'Your turn — make a move';
    DOM.statusText.classList.add('status-text--your-turn');
  } else {
    DOM.statusText.textContent = 'Engine is thinking…';
    DOM.statusText.classList.add('status-text--engine');
  }
}


/* ============================================================
   LOADING OVERLAY
   ============================================================ */

function _showLoading(message) {
  const loader = document.getElementById('stockfish-loader');
  if (loader) loader.style.display = 'inline-block';
}

function _hideLoading() {
  const loader = document.getElementById('stockfish-loader');
  if (loader) loader.style.display = 'none';
}


/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */

function _showToast(message, type) {
  const toast = document.createElement('div');
  toast.className  = `toast toast--${type || 'info'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast--visible')));
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}


/* ============================================================
   AUDIO-VISUAL FEEDBACK
   ============================================================ */

let _sharedAudioCtx = null;

function _getAudioCtx() {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === 'closed') {
    try { _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (_sharedAudioCtx.state === 'suspended') _sharedAudioCtx.resume().catch(() => {});
  return _sharedAudioCtx;
}

function _playWoodTap(volume = 0.62, isCapture = false) {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(), oscGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isCapture ? 780 : 920, t);
    osc.frequency.exponentialRampToValueAtTime(isCapture ? 130 : 180, t + (isCapture ? 0.075 : 0.055));
    oscGain.gain.setValueAtTime(volume, t);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + (isCapture ? 0.075 : 0.055));
    osc.connect(oscGain); oscGain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.09);

    const noiseDur = isCapture ? 0.055 : 0.038;
    const buf      = ctx.createBuffer(1, Math.floor(ctx.sampleRate * noiseDur), ctx.sampleRate);
    const data     = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf;
    const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass';
    bpf.frequency.value = isCapture ? 900 : 1100; bpf.Q.value = isCapture ? 2.0 : 2.8;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(volume * (isCapture ? 0.75 : 0.55), t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + noiseDur);
    noise.connect(bpf); bpf.connect(noiseGain); noiseGain.connect(ctx.destination);
    noise.start(t); noise.stop(t + noiseDur);
  } catch (e) {}
}

function _playCheckDrum() {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    function knock(delay, freq, vol) {
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.18, t + 0.09);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.1);
    }
    knock(0.00, 820, 0.70);
    knock(0.13, 700, 0.85);
    const rumble = ctx.createOscillator(), rg = ctx.createGain();
    rumble.type = 'sine';
    rumble.frequency.setValueAtTime(60, ctx.currentTime + 0.01);
    rg.gain.setValueAtTime(0.3, ctx.currentTime + 0.01);
    rg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    rumble.connect(rg); rg.connect(ctx.destination);
    rumble.start(ctx.currentTime + 0.01); rumble.stop(ctx.currentTime + 0.26);
  } catch (e) {}
}

function _clearCheckAlarm() {
  document.querySelectorAll('.check-alarm').forEach(el => el.classList.remove('check-alarm'));
}

function _playMoveFeedback(isCheck, evalType, isCapture, kingSquare) {
  _clearCheckAlarm();
  let ttsText = '', animText = '', animClass = '';

  if (isCheck) {
    _playCheckDrum();
    if (kingSquare) {
      const kingEl = document.querySelector(`[data-square="${kingSquare}"]`);
      if (kingEl) kingEl.classList.add('check-alarm');
    }
    ttsText = 'Check!'; animText = 'CHECK!'; animClass = 'action-blunder';
  } else if (evalType === 'blunder' || evalType === 'mistake') {
    _playWoodTap(0.50, isCapture);
    ttsText = evalType === 'blunder' ? "Watch out, that's a blunder!" : "That was a mistake.";
    animText = evalType === 'blunder' ? '🚨 BLUNDER!' : '⚠️ MISTAKE';
    animClass = 'action-blunder';
  } else if (evalType === 'good' || evalType === 'brilliant') {
    _playWoodTap(0.55, isCapture);
    ttsText = 'Excellent move!';
    animText = '🌟 EXCELLENT';
    animClass = 'action-good';
  } else {
    _playWoodTap(isCapture ? 0.75 : 0.62, isCapture);
  }

  if (animText) {
    const textEl = document.getElementById('center-action-text');
    if (textEl) {
      textEl.classList.remove('pop-action', 'action-good', 'action-blunder', 'action-standard');
      void textEl.offsetWidth;
      textEl.textContent = animText;
      textEl.classList.add(animClass, 'pop-action');
    }
  }

  if (ttsText && window.speakCoachText) window.speakCoachText(ttsText);
}


/* ============================================================
   VOICE COACH (Web Speech API)
   ============================================================ */

let _voicesReady = false;
function _primeSpeechVoices() {
  if (_voicesReady) return;
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  if (voices.length > 0) { _voicesReady = true; return; }
  if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => { _voicesReady = true; };
  }
}
if (typeof speechSynthesis !== 'undefined') _primeSpeechVoices();

window.speakCoachText = function(text, textHi, cancel = true) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    const isHindi  = localStorage.getItem('audio_lang') === 'hi';
    const toSpeak  = isHindi ? (textHi || text) : text;

    function pickVoice() {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return null;
      return voices.find(v => v.name.includes('David') || v.name.includes('Zira') || v.name.includes('Mark'))
        || voices.find(v => v.lang.startsWith('en') && v.localService)
        || voices.find(v => v.lang.startsWith('en'))
        || null;
    }

    function doSpeak() {
      const utt   = new SpeechSynthesisUtterance(toSpeak);
      const voice = pickVoice();
      if (voice) utt.voice = voice;
      utt.rate  = 0.95;
      utt.pitch = 1.0;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      utt.onend   = settle;
      utt.onerror = (e) => { console.warn('[TTS]', e.error); settle(); };
      const hb = setInterval(() => { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); }, 500);
      utt.onend = () => { clearInterval(hb); settle(); };
      window.speechSynthesis.speak(utt);
      setTimeout(() => { clearInterval(hb); settle(); }, 15000);
    }

    if (cancel) {
      window.speechSynthesis.cancel();
      setTimeout(doSpeak, 60);
    } else {
      doSpeak();
    }
  });
};


/* ============================================================
   COACH SUGGESTIONS (Engine MultiPV)
   ============================================================ */

let _consentPending = { uci: null, san: null };

async function _fetchAndShowSuggestions(fen) {
  if (STATE.currentMode !== 'learn') return;
  if (!STATE.gameActive) return;
  if (!DOM.coachSuggestions || !DOM.suggestionCards) return;

  DOM.coachSuggestions.style.display = 'block';
  DOM.suggestionCards.innerHTML = '<div class="suggestion-card" style="text-align:center; color:#94a3b8;"><span class="typing-indicator">Analyzing position<span>.</span><span>.</span><span>.</span></span></div>';

  try {
    const multiResult = await _engineGetMultiPV(fen, 3);
    if (!multiResult || !multiResult.lines || !multiResult.lines.length) {
      DOM.coachSuggestions.style.display = 'none';
      return;
    }

    // Convert engine lines to suggestion objects
    const suggestions = multiResult.lines.map((line, idx) => {
      if (!line || !line.bestMove) return null;
      const uci   = line.bestMove;
      const from  = uci.slice(0, 2), to = uci.slice(2, 4);
      // Try to get SAN
      const tempGame = new Chess(fen);
      const m = tempGame.move({ from, to, promotion: uci.length > 4 ? uci[4] : undefined });
      const san = m ? m.san : uci;

      const cp  = line.score ? line.score.value : 0;
      const pawns = cp / 100;
      const scoreStr = (pawns >= 0 ? '+' : '') + pawns.toFixed(2);

      let displayText = '';
      if (idx === 0) displayText = `Best move — Eval: ${scoreStr}`;
      else           displayText = `Alternative — Eval: ${scoreStr}`;

      return {
        uci, san, eval_score: pawns, display_text: displayText,
        isTopMove: idx === 0, multipv: idx + 1
      };
    }).filter(Boolean);

    if (!suggestions.length) { DOM.coachSuggestions.style.display = 'none'; return; }
    if (suggestions.length > 0) suggestions[0].isTopMove = true;

    // Shuffle for "blind choice"
    for (let i = suggestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [suggestions[i], suggestions[j]] = [suggestions[j], suggestions[i]];
    }

    _renderSuggestionCards(suggestions);
    const ttsText = suggestions.map((s, i) => `Option ${i + 1}: ${s.san}`).join('. ');
    if (window.speakCoachText) window.speakCoachText(ttsText);

  } catch (err) {
    console.error('[Suggestions] Error:', err);
    DOM.coachSuggestions.style.display = 'none';
  }
}

function _renderSuggestionCards(suggestions) {
  if (!DOM.suggestionCards) return;
  DOM.suggestionCards.innerHTML = '';
  STATE.currentSuggestions = suggestions;

  suggestions.forEach((s, index) => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    card.setAttribute('role', 'listitem');
    card.innerHTML = `
      <div class="suggestion-card__header">
        <span class="suggestion-card__rank">Option ${index + 1}</span>
        <span class="suggestion-card__san">${s.san}</span>
      </div>
      <p class="suggestion-card__explanation">${s.display_text || ''}</p>
      <button class="suggestion-card__btn" data-uci="${s.uci}" data-san="${s.san}" data-index="${index}">
        <span aria-hidden="true">▶</span> Play this Move
      </button>
    `;
    card.querySelector('.suggestion-card__btn').addEventListener('click', () => _openConsentModal(index));
    DOM.suggestionCards.appendChild(card);
  });
}

function _openConsentModal(selectedIndex) {
  if (!STATE.gameActive) return;
  const suggestions = STATE.currentSuggestions || [];
  if (!suggestions.length) return;

  const chosen = suggestions[selectedIndex];
  const best   = suggestions.find(s => s.isTopMove) || suggestions[0];
  if (!chosen) return;

  _consentPending.uci = chosen.uci;
  _consentPending.san = chosen.san;

  const score1 = best.eval_score   !== undefined ? best.eval_score   : null;
  const score2 = chosen.eval_score !== undefined ? chosen.eval_score : null;
  const delta  = (score1 !== null && score2 !== null) ? Math.abs(score1 - score2) : null;
  const THRESHOLD = 0.40;

  let icon = '🤔', consentText = '';
  if (chosen.isTopMove) {
    consentText = 'Excellent evaluation! You found the strongest engine recommendation. Confirm to play?';
    icon = '🌟';
  } else if (delta !== null && delta <= THRESHOLD) {
    consentText = 'Great choice. This move is practically equal in strength to the top recommendation. Confirm?';
    icon = '👍';
  } else {
    consentText = 'This is a solid idea, but a stronger continuation is available. Rethink or play anyway?';
    icon = '⚠️';
  }

  if (DOM.consentIcon)    DOM.consentIcon.textContent    = icon;
  if (DOM.consentMessage) DOM.consentMessage.textContent = consentText;
  if (DOM.consentScore1)  DOM.consentScore1.textContent  = score1 !== null ? `${score1 >= 0 ? '+' : ''}${score1.toFixed(2)}` : '—';
  if (DOM.consentScore2)  DOM.consentScore2.textContent  = score2 !== null ? `${score2 >= 0 ? '+' : ''}${score2.toFixed(2)}` : '—';
  if (DOM.consentDelta) {
    DOM.consentDelta.textContent = delta !== null ? `−${delta.toFixed(2)}` : '—';
    DOM.consentDelta.style.color = (delta !== null && delta > THRESHOLD) ? '#f87171' : '#4ade80';
  }

  if (DOM.consentOverlay) DOM.consentOverlay.style.display = 'flex';
  if (window.speakCoachText) window.speakCoachText(consentText);
}

function _closeConsentModal() {
  if (DOM.consentOverlay) DOM.consentOverlay.style.display = 'none';
  _consentPending.uci = null;
  _consentPending.san = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function _executeConsentMove() {
  const { uci, san } = _consentPending;
  if (!uci || !STATE.gameActive) { _closeConsentModal(); return; }
  _closeConsentModal();
  _clearSuggestions();

  const from      = uci.slice(0, 2);
  const to        = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  const fenBefore = STATE.game.fen();

  const move = STATE.game.move({ from, to, promotion: promotion || undefined });
  if (!move) { _showToast('Could not play suggested move.', 'error'); return; }

  if (promotion) STATE.board.position(STATE.game.fen());
  else           STATE.board.move(`${from}-${to}`);

  _highlightLastMove(from, to);
  const fenAfter = STATE.game.fen();
  const moveUci  = from + to + (promotion || '');

  _processPlayerMove(fenBefore, fenAfter, move.san, moveUci);
}

function _clearSuggestions() {
  if (DOM.coachSuggestions) DOM.coachSuggestions.style.display = 'none';
  if (DOM.suggestionCards)  DOM.suggestionCards.innerHTML = '';
  STATE.currentSuggestions = [];
}

function _clearBlunderState() {
  STATE.blunderPending   = false;
  STATE.fenBeforeBlunder = null;
  STATE.fenAfterBlunder  = null;
  STATE.blunderMoveSan   = null;
  STATE.blunderMoveUci   = null;
  STATE.cpLoss           = 0;
}


/* ============================================================
   SETTINGS — Board Theme & Piece Style
   ============================================================ */

const BOARD_THEMES = {
  classic:  { light: '#f0d9b5', dark: '#b58863' },
  ocean:    { light: '#c9e8f0', dark: '#3d7fa3' },
  forest:   { light: '#eeeed2', dark: '#769656' },
  midnight: { light: '#8296a8', dark: '#1a2b38' },
  crimson:  { light: '#f0d4c4', dark: '#8f2020' },
  purple:   { light: '#e8d9f0', dark: '#6a3d9a' },
};

function _applyBoardTheme(theme) {
  const t = BOARD_THEMES[theme] || BOARD_THEMES.classic;
  let styleEl = document.getElementById('board-theme-override');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'board-theme-override';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = [
    `#chess-board .white-1e1d7 { background-color: ${t.light} !important; }`,
    `#chess-board .black-3c85d { background-color: ${t.dark}  !important; }`,
  ].join('\n');
  localStorage.setItem('board_theme', theme);
  document.querySelectorAll('.theme-swatch').forEach(btn =>
    btn.classList.toggle('theme-swatch--active', btn.dataset.theme === theme)
  );
}

function _applyPieceStyle(style) {
  const boardWrap = document.querySelector('.chess-board-wrap');
  if (boardWrap) {
    boardWrap.classList.remove('piece-style-classic', 'piece-style-neon', 'piece-style-royal');
    if (style !== 'classic') boardWrap.classList.add(`piece-style-${style}`);
  }
  localStorage.setItem('piece_style', style);
  document.querySelectorAll('.piece-style-btn').forEach(btn =>
    btn.classList.toggle('piece-style-btn--active', btn.dataset.style === style)
  );
}

function _openSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const savedTheme = localStorage.getItem('board_theme') || 'classic';
  const savedStyle = localStorage.getItem('piece_style') || 'classic';
  document.querySelectorAll('.theme-swatch').forEach(btn =>
    btn.classList.toggle('theme-swatch--active', btn.dataset.theme === savedTheme)
  );
  document.querySelectorAll('.piece-style-btn').forEach(btn =>
    btn.classList.toggle('piece-style-btn--active', btn.dataset.style === savedStyle)
  );
}

function _closeSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.style.display = 'none';
}

function _initSettings() {
  _applyBoardTheme(localStorage.getItem('board_theme') || 'classic');
  _applyPieceStyle(localStorage.getItem('piece_style') || 'classic');

  // Both settings buttons (header + board)
  ['btn-settings', 'btn-settings-board'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', _openSettings);
  });

  ['btn-close-settings', 'btn-close-settings-footer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', _closeSettings);
  });

  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) _closeSettings(); });

  document.querySelectorAll('.theme-swatch').forEach(btn =>
    btn.addEventListener('click', () => _applyBoardTheme(btn.dataset.theme))
  );
  document.querySelectorAll('.piece-style-btn').forEach(btn =>
    btn.addEventListener('click', () => _applyPieceStyle(btn.dataset.style))
  );
}
