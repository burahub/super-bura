const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;

const CARD_VALUES = {
    '7': 0, '8': 0, '9': 0, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11
};
const RANKS_ORDER = ['7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const SUITS = ['spades', 'clubs', 'hearts', 'diamonds'];
const TRUMP_ROTATION = ['spades', 'clubs', 'hearts', 'diamonds', 'no_trump']; // 1 პარტია = 5 ხელი

let rooms = {};

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let rank of RANKS_ORDER) {
            deck.push({ rank, suit, value: CARD_VALUES[rank] });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function createRoom(roomId, maxPlayers, targetParties) {
    return {
        id: roomId,
        maxPlayers: parseInt(maxPlayers),
        targetParties: parseInt(targetParties),
        players: [],
        gameState: null
    };
}

function startNewHand(room, previousGame = null) {
    let deck = createDeck();
    let playersCards = {};
    let takenCards = {};
    let totalScores = {};

    room.players.forEach((p) => {
        playersCards[p.id] = deck.splice(0, 5);
        takenCards[p.id] = [];
        totalScores[p.id] = previousGame ? (previousGame.totalScores[p.id] || 0) : 0;
    });

    let handIndex = previousGame ? previousGame.handIndex + 1 : 1;
    let partyNum = Math.ceil(handIndex / 5);
    let trumpIndex = (handIndex - 1) % 5;
    let currentTrump = TRUMP_ROTATION[trumpIndex];

    let startLeaderIndex = 0;
    if (previousGame && previousGame.nextRoundLeaderIndex !== undefined) {
        startLeaderIndex = previousGame.nextRoundLeaderIndex;
    }

    let roundHistory = previousGame ? previousGame.roundHistory : [];

    return {
        deck,
        playersCards,
        takenCards,
        totalScores,
        currentTurnIndex: startLeaderIndex,
        table: [],
        trump: currentTrump,
        partyNum: partyNum,
        handIndex: handIndex,
        roundHistory: roundHistory,
        leadCardCount: null,
        isProcessing: false,
        gameOver: false
    };
}

function beatsPlay(leadPlay, challengePlay, trump) {
    let leadCards = leadPlay.cards;
    let challengeCards = challengePlay.cards;

    if (challengeCards.length === 5 && leadCards.length < 5) {
        let challengeSuit = challengeCards[0].suit;
        return challengeCards.every(c => c.suit === challengeSuit);
    }

    if (leadCards.length !== challengeCards.length) return false;

    let challengeSuit = challengeCards[0].suit;
    let allSameSuit = challengeCards.every(c => c.suit === challengeSuit);
    if (!allSameSuit) return false;

    let leadSuit = leadCards[0].suit;
    let isChallengeTrump = (trump !== 'no_trump' && challengeSuit === trump);
    let isLeadTrump = (trump !== 'no_trump' && leadSuit === trump);

    if (isChallengeTrump && !isLeadTrump) return true;
    if (isLeadTrump && !isChallengeTrump) return false;

    if (challengeSuit === leadSuit) {
        let maxLeadRank = Math.max(...leadCards.map(c => RANKS_ORDER.indexOf(c.rank)));
        let maxChallengeRank = Math.max(...challengeCards.map(c => RANKS_ORDER.indexOf(c.rank)));
        return maxChallengeRank > maxLeadRank;
    }

    return false;
}

function getWinningPlayIndex(table, trump) {
    if (table.length === 0) return -1;
    let winningIdx = 0;
    for (let i = 1; i < table.length; i++) {
        if (beatsPlay(table[winningIdx], table[i], trump)) {
            winningIdx = i;
        }
    }
    return winningIdx;
}

io.on('connection', (socket) => {

    socket.on('joinGame', ({ name, capacity, parties }) => {
        let maxP = parseInt(capacity) || 2;
        let targetParties = parseInt(parties) || 1;
        let playerName = name.trim() || 'მოთამაშე';

        let availableRoom = Object.values(rooms).find(r => 
            r.maxPlayers === maxP && 
            r.targetParties === targetParties && 
            r.players.length < maxP && 
            !r.gameState
        );

        if (!availableRoom) {
            let roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            availableRoom = createRoom(roomId, maxP, targetParties);
            rooms[roomId] = availableRoom;
        }

        socket.roomId = availableRoom.id;
        availableRoom.players.push({ id: socket.id, name: playerName });
        socket.join(availableRoom.id);

        if (availableRoom.players.length === availableRoom.maxPlayers) {
            availableRoom.gameState = startNewHand(availableRoom);
            io.to(availableRoom.id).emit('gameStateUpdate', getClientGameState(availableRoom));
        } else {
            io.to(availableRoom.id).emit('waitingForPlayers', {
                current: availableRoom.players.length,
                max: availableRoom.maxPlayers
            });
        }
    });

    socket.on('playCards', (cardIndices) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        let room = rooms[socket.roomId];
        let gs = room.gameState;

        if (!gs || gs.isProcessing || gs.gameOver) return;

        let activePlayer = room.players[gs.currentTurnIndex];
        if (activePlayer.id !== socket.id) return;

        let playerCards = gs.playersCards[socket.id];
        let selectedCards = cardIndices.map(i => playerCards[i]).filter(Boolean);

        if (selectedCards.length === 0 || selectedCards.length !== cardIndices.length) return;

        let isMaliutka = (selectedCards.length === 5) && selectedCards.every(c => c.suit === selectedCards[0].suit);

        if (gs.table.length === 0) {
            let firstSuit = selectedCards[0].suit;
            let isSameSuit = selectedCards.every(c => c.suit === firstSuit);
            if (!isSameSuit) {
                socket.emit('errorMessage', 'ჩამომსვლელს შეუძლია მხოლოდ ერთი ცვეტის კარტების დადება!');
                return;
            }

            gs.leadCardCount = selectedCards.length;
            gs.playersCards[socket.id] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: socket.id, playerName: activePlayer.name, cards: selectedCards });

            gs.currentTurnIndex = (gs.currentTurnIndex + 1) % room.players.length;
            io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
        } 
        else {
            if (!isMaliutka && selectedCards.length !== gs.leadCardCount) {
                socket.emit('errorMessage', 'უნდა ჩამოხვიდეთ ზუსტად ' + gs.leadCardCount + ' კარტი (ან მალიუტკა)!');
                return;
            }

            if (isMaliutka) {
                gs.leadCardCount = 5;
            }

            gs.playersCards[socket.id] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: socket.id, playerName: activePlayer.name, cards: selectedCards });

            if (gs.table.length < room.players.length) {
                gs.currentTurnIndex = (gs.currentTurnIndex + 1) % room.players.length;
                io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
            } else {
                let winIdx = getWinningPlayIndex(gs.table, gs.trump);
                let winningPlay = gs.table[winIdx];

                let winnerId = winningPlay.playerId;
                let allTableCards = [];
                gs.table.forEach(p => allTableCards.push(...p.cards));
                gs.takenCards[winnerId].push(...allTableCards);

                let winnerIndex = room.players.findIndex(p => p.id === winnerId);
                gs.currentTurnIndex = winnerIndex;
                gs.isProcessing = true;

                io.to(room.id).emit('gameStateUpdate', getClientGameState(room));

                setTimeout(() => {
                    gs.table = [];
                    gs.leadCardCount = null;

                    for (let step = 0; step < room.players.length; step++) {
                        let pIdx = (winnerIndex + step) % room.players.length;
                        let pId = room.players[pIdx].id;
                        while (gs.playersCards[pId].length < 5 && gs.deck.length > 0) {
                            gs.playersCards[pId].push(gs.deck.pop());
                        }
                    }

                    let allHandsEmpty = room.players.every(p => gs.playersCards[p.id].length === 0);
                    gs.isProcessing = false;

                    if (allHandsEmpty) {
                        finishHand(room);
                    } else {
                        io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
                    }
                }, 2000);
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(room.id).emit('playerLeft');
            delete rooms[socket.roomId];
        }
    });
});

function finishHand(room) {
    let gs = room.gameState;
    let handScores = {};
    let minScore = Infinity;
    let minPlayerIndex = 0;

    room.players.forEach((p, idx) => {
        let pts = gs.takenCards[p.id].reduce((sum, c) => sum + c.value, 0);
        handScores[p.id] = pts;
        gs.totalScores[p.id] = (gs.totalScores[p.id] || 0) + pts;

        if (pts < minScore) {
            minScore = pts;
            minPlayerIndex = idx;
        }
    });

    // ისტორიაში ჩაწერილი შედეგი
    gs.roundHistory.push({
        handIndex: gs.handIndex,
        trump: gs.trump,
        scores: handScores
    });

    let totalMaxHands = room.targetParties * 5;

    if (gs.handIndex >= totalMaxHands) {
        gs.gameOver = true;
        io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
    } else {
        let nextLeaderIndex = (minPlayerIndex + 1) % room.players.length;
        gs.nextRoundLeaderIndex = nextLeaderIndex;
        room.gameState = startNewHand(room, gs);
        io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
    }
}

function getClientGameState(room) {
    let gs = room.gameState;
    let winningIndex = getWinningPlayIndex(gs.table, gs.trump);

    let playersSummary = room.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        cardCount: gs.playersCards[p.id] ? gs.playersCards[p.id].length : 0,
        takenCount: gs.takenCards[p.id] ? gs.takenCards[p.id].length : 0,
        handPoints: gs.takenCards[p.id] ? gs.takenCards[p.id].reduce((a, b) => a + b.value, 0) : 0,
        totalPoints: gs.totalScores[p.id] || 0,
        isCurrent: idx === gs.currentTurnIndex
    }));

    return {
        table: gs.table.map((play, idx) => ({
            ...play,
            isWinning: idx === winningIndex
        })),
        trump: gs.trump,
        partyNum: gs.partyNum,
        targetParties: room.targetParties,
        handIndex: gs.handIndex,
        players: playersSummary,
        playersCards: gs.playersCards,
        currentTurnIndex: gs.currentTurnIndex,
        isProcessing: gs.isProcessing,
        deckCount: gs.deck.length,
        roundHistory: gs.roundHistory,
        gameOver: gs.gameOver
    };
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ka">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ბურა ონლაინ / Premium Blue Bura</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body { background: radial-gradient(circle at center, #0a192f 0%, #020c1b 100%); color: white; margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
        
        #lobby { position: fixed; inset: 0; background: rgba(2, 12, 27, 0.95); display: flex; justify-content: center; align-items: center; z-index: 100; backdrop-filter: blur(10px); }
        .lobby-card { background: #0f2b48; padding: 35px; border-radius: 20px; border: 2px solid #00d2ff; box-shadow: 0 0 30px rgba(0, 210, 255, 0.3); text-align: center; width: 360px; }
        .lobby-card h2 { margin-top: 0; color: #00d2ff; text-shadow: 0 0 10px rgba(0,210,255,0.5); font-size: 26px; }
        .input-group { margin: 15px 0; text-align: left; }
        .input-group label { display: block; margin-bottom: 6px; font-size: 14px; color: #8892b0; }
        .input-group input, .input-group select { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #1e4976; background: #0a192f; color: white; font-size: 16px; outline: none; }
        .input-group input:focus, .input-group select:focus { border-color: #00d2ff; box-shadow: 0 0 8px rgba(0,210,255,0.5); }
        .btn-start { width: 100%; padding: 14px; background: linear-gradient(135deg, #00d2ff 0%, #0072ff 100%); border: none; border-radius: 10px; color: #fff; font-weight: bold; font-size: 18px; cursor: pointer; transition: 0.3s; margin-top: 15px; box-shadow: 0 4px 15px rgba(0,114,255,0.4); }
        .btn-start:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,210,255,0.6); }

        #game-container { display: none; width: 100%; max-width: 1050px; padding: 15px; flex-direction: column; align-items: center; }
        
        .top-bar { width: 100%; background: rgba(15, 43, 72, 0.7); backdrop-filter: blur(12px); border-radius: 15px; border: 1px solid rgba(0, 210, 255, 0.3); padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
        .info-badge { background: rgba(10, 25, 47, 0.8); padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 15px; border: 1px solid rgba(255,255,255,0.1); }
        
        .leaderboard { width: 100%; background: rgba(15, 43, 72, 0.5); border-radius: 12px; padding: 12px; margin-bottom: 15px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; border: 1px solid rgba(255,255,255,0.05); }
        .player-card { background: rgba(10, 25, 47, 0.6); padding: 10px 14px; border-radius: 10px; border-left: 4px solid #334155; transition: 0.3s; }
        .player-card.active { border-left-color: #00d2ff; background: rgba(0, 210, 255, 0.12); box-shadow: 0 0 15px rgba(0, 210, 255, 0.2); }
        .player-card .p-name { font-weight: bold; font-size: 16px; color: #e2e8f0; }
        .player-card .p-stats { font-size: 13px; color: #94a3b8; margin-top: 4px; }

        #poker-table { width: 100%; min-height: 250px; background: radial-gradient(circle, #133a63 0%, #081a30 100%); border: 10px solid #0b223d; border-radius: 140px; box-shadow: inset 0 0 50px rgba(0,0,0,0.9), 0 10px 30px rgba(0,210,255,0.15); display: flex; justify-content: center; align-items: center; gap: 20px; padding: 25px; margin: 10px 0; position: relative; }
        
        .table-play-group { display: flex; flex-direction: column; align-items: center; background: rgba(2, 12, 27, 0.5); padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); position: relative; }
        .table-play-group.winning-play { border: 2px solid #ffcc00; box-shadow: 0 0 20px rgba(255, 204, 0, 0.6); }
        .player-tag { font-size: 12px; font-weight: bold; color: #00d2ff; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1px; }
        .table-play-group.winning-play .player-tag { color: #ffcc00; }
        .cards-flex { display: flex; gap: 6px; }

        .card { width: 75px; height: 110px; background: #ffffff; border-radius: 8px; border: 1px solid #cbd5e1; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: flex; flex-direction: column; justify-content: space-between; padding: 6px; font-weight: bold; position: relative; transition: all 0.2s ease; cursor: pointer; user-select: none; }
        .card:hover { transform: translateY(-8px); box-shadow: 0 8px 20px rgba(0,210,255,0.4); }
        .card.selected { border: 3px solid #00d2ff; transform: translateY(-16px); box-shadow: 0 0 20px rgba(0, 210, 255, 0.9); }
        .card.red { color: #e11d48; }
        .card.black { color: #0f172a; }
        .card .rank-top { font-size: 15px; line-height: 1; }
        .card .suit-center { font-size: 32px; text-align: center; line-height: 1; margin: auto; }
        .card .rank-bottom { font-size: 15px; text-align: right; line-height: 1; }

        .action-container { display: flex; gap: 15px; justify-content: center; align-items: center; margin-top: 15px; }
        #my-cards { display: flex; justify-content: center; gap: 12px; margin-top: 15px; min-height: 125px; flex-wrap: wrap; }
        #status-msg { font-size: 20px; font-weight: bold; color: #00d2ff; margin: 10px 0; min-height: 28px; text-shadow: 0 0 8px rgba(0,210,255,0.4); }
        
        .play-btn { padding: 12px 35px; font-size: 18px; background: linear-gradient(135deg, #00d2ff 0%, #0072ff 100%); border: none; border-radius: 25px; color: #fff; font-weight: bold; cursor: pointer; box-shadow: 0 4px 15px rgba(0,114,255,0.4); transition: 0.2s; }
        .play-btn:disabled { background: #334155; color: #64748b; cursor: not-allowed; box-shadow: none; }

        .maliutka-btn { padding: 12px 25px; font-size: 18px; background: linear-gradient(135deg, #ff007f 0%, #7928ca 100%); border: 2px solid #fff; border-radius: 25px; color: #fff; font-weight: bold; cursor: pointer; box-shadow: 0 0 20px rgba(255, 0, 127, 0.8); animation: pulse 1.5s infinite; }
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.06); }
            100% { transform: scale(1); }
        }

        /* History Table */
        .history-box { width: 100%; background: rgba(15, 43, 72, 0.6); border-radius: 12px; padding: 15px; margin-top: 20px; border: 1px solid rgba(0,210,255,0.2); }
        .history-box h3 { margin-top: 0; color: #00d2ff; font-size: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; }
        .history-table { width: 100%; border-collapse: collapse; font-size: 14px; text-align: center; }
        .history-table th { background: rgba(10, 25, 47, 0.8); color: #8892b0; padding: 8px; font-weight: 600; }
        .history-table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #e2e8f0; }

        .red-text { color: #ff4d4d; font-weight: bold; }
        .black-text { color: #ffffff; font-weight: bold; }
    </style>
</head>
<body>

    <div id="lobby">
        <div class="lobby-card">
            <h2>♠  ბურა ონლაინ ♣</h2>
            <div class="input-group">
                <label>თქვენი სახელი:</label>
                <input type="text" id="player-name" value="მოთამაშე" maxlength="12">
            </div>
            <div class="input-group">
                <label>მოთამაშეების რაოდენობა:</label>
                <select id="player-capacity">
                    <option value="2">2 მოთამაშე</option>
                    <option value="3">3 მოთამაშე</option>
                    <option value="4">4 მოთამაშე</option>
                </select>
            </div>
            <div class="input-group">
                <label>პარტიების რაოდენობა (1 პარტია = 5 ხელი):</label>
                <select id="player-parties">
                    <option value="1">1 პარტია (5 ხელი)</option>
                    <option value="2">2 პარტია (10 ხელი)</option>
                    <option value="4">4 პარტია (20 ხელი)</option>
                </select>
            </div>
            <button class="btn-start" onclick="joinLobby()">თამაშის დაწყება</button>
            <p id="lobby-wait" style="display:none; color:#00d2ff; margin-top:15px; font-weight:bold;"></p>
        </div>
    </div>

    <div id="game-container">
        <div class="top-bar">
            <div class="info-badge">პარტია: <b id="party-num">1</b> / <span id="target-parties">1</span></div>
            <div class="info-badge">ხელი: <b id="hand-num">1</b></div>
            <div class="info-badge">კოზირი: <span id="trump-display">-</span></div>
            <div class="info-badge">დასტაში დარჩა: <b id="deck-count">-</b></div>
        </div>

        <div class="leaderboard" id="leaderboard"></div>

        <div id="status-msg">ველით მოთამაშეებს...</div>

        <div id="poker-table"></div>

        <h3>ჩემი კარტები</h3>
        <div id="my-cards"></div>
        
        <div class="action-container">
            <button id="play-btn" class="play-btn" onclick="playSelectedCards()" disabled>ჩამოსვლა</button>
            <button id="maliutka-btn" class="maliutka-btn" onclick="playMaliutka()" style="display:none;">♣ მალიუტკა ♠</button>
        </div>

        <!-- ხელების ისტორიის ცხრილი -->
        <div class="history-box">
            <h3>ხელების ისტორია & ქულები</h3>
            <table class="history-table" id="history-table">
                <thead>
                    <tr id="history-head">
                        <th>ხელი #</th>
                        <th>კოზირი</th>
                    </tr>
                </thead>
                <tbody id="history-body"></tbody>
            </table>
        </div>
    </div>

    <script>
        const socket = io();
        let myCards = [];
        let selectedIndices = [];
        let myId = null;

        const SUIT_SYMBOLS = {
            'spades': '♠', 'clubs': '♣', 'hearts': '♥', 'diamonds': '♦', 'no_trump': 'ბეზი'
        };

        socket.on('connect', () => { myId = socket.id; });
        socket.on('errorMessage', (msg) => { alert(msg); });
        socket.on('playerLeft', () => { alert('ერთ-ერთი მოთამაშე გავიდა. თამაში დასრულდა.'); location.reload(); });

        function joinLobby() {
            let name = document.getElementById('player-name').value;
            let capacity = document.getElementById('player-capacity').value;
            let parties = document.getElementById('player-parties').value;
            socket.emit('joinGame', { name, capacity, parties });
            document.querySelector('.btn-start').style.display = 'none';
            document.getElementById('lobby-wait').style.display = 'block';
            document.getElementById('lobby-wait').innerText = 'ეძებს მოთამაშეებს...';
        }

        socket.on('waitingForPlayers', (data) => {
            document.getElementById('lobby-wait').innerText = 'ველით მოთამაშეებს: (' + data.current + '/' + data.max + ')';
        });

        socket.on('gameStateUpdate', (gs) => {
            document.getElementById('lobby').style.display = 'none';
            document.getElementById('game-container').style.display = 'flex';

            document.getElementById('party-num').innerText = gs.partyNum;
            document.getElementById('target-parties').innerText = gs.targetParties;
            document.getElementById('hand-num').innerText = gs.handIndex;
            document.getElementById('deck-count').innerText = gs.deckCount;

            let trumpText = SUIT_SYMBOLS[gs.trump] || gs.trump;
            let trumpSpan = document.getElementById('trump-display');
            if (gs.trump === 'hearts' || gs.trump === 'diamonds') {
                trumpSpan.innerHTML = '<span class="red-text">' + trumpText + '</span>';
            } else {
                trumpSpan.innerHTML = '<span class="black-text">' + trumpText + '</span>';
            }

            // ლიდერბორდის განახლება
            let lbDiv = document.getElementById('leaderboard');
            lbDiv.innerHTML = '';
            gs.players.forEach(p => {
                let pDiv = document.createElement('div');
                pDiv.className = 'player-card ' + (p.isCurrent ? 'active' : '');
                let isMe = p.id === myId ? ' (შენ)' : '';
                pDiv.innerHTML = '<div class="p-name">' + p.name + isMe + '</div>' +
                                 '<div class="p-stats">ამ ხელში: <b>' + p.handPoints + '</b> ქულა</div>' +
                                 '<div class="p-stats">სულ ჯამში: <b style="color:#00d2ff;">' + p.totalPoints + '</b> ქულა</div>';
                lbDiv.appendChild(pDiv);
            });

            // სვლის/გამარჯვებულის სტატუსი
            let activePlayer = gs.players[gs.currentTurnIndex];
            let isMyTurn = (activePlayer && activePlayer.id === myId) && !gs.isProcessing && !gs.gameOver;
            
            if (gs.gameOver) {
                // თამაშის დასრულება და გამარჯვებულის გამოვლენა
                let winner = [...gs.players].sort((a,b) => b.totalPoints - a.totalPoints)[0];
                document.getElementById('status-msg').innerText = "🏆 თამაში დასრულდა! გაიმარჯვა: " + winner.name + " (" + winner.totalPoints + " ქულა)";
            } else if (gs.isProcessing) {
                document.getElementById('status-msg').innerText = "ითვლება სლიკი...";
            } else if (isMyTurn) {
                document.getElementById('status-msg').innerText = "თქვენი სვლაა!";
            } else {
                document.getElementById('status-msg').innerText = (activePlayer ? activePlayer.name : '') + "-ის სვლაა...";
            }

            document.getElementById('play-btn').disabled = !isMyTurn;

            // მაგიდაზე ჩამოსული კარტების ჩვენება + ვინ იჭერს
            let tableDiv = document.getElementById('poker-table');
            tableDiv.innerHTML = '';
            gs.table.forEach(play => {
                let groupDiv = document.createElement('div');
                groupDiv.className = 'table-play-group ' + (play.isWinning ? 'winning-play' : '');
                
                let tag = document.createElement('div');
                tag.className = 'player-tag';
                tag.innerText = play.playerName + (play.isWinning ? ' (იჭერს)' : '');
                groupDiv.appendChild(tag);

                let cardsFlex = document.createElement('div');
                cardsFlex.className = 'cards-flex';
                play.cards.forEach(c => {
                    cardsFlex.appendChild(renderCardUI(c));
                });
                groupDiv.appendChild(cardsFlex);

                tableDiv.appendChild(groupDiv);
            });

            // ჩემი კარტები
            myCards = gs.playersCards[myId] || [];
            selectedIndices = selectedIndices.filter(i => i < myCards.length);

            let hasMaliutka = myCards.length === 5 && myCards.every(c => c.suit === myCards[0].suit);
            let maliutkaBtn = document.getElementById('maliutka-btn');
            
            if (hasMaliutka && isMyTurn) {
                maliutkaBtn.style.display = 'inline-block';
            } else {
                maliutkaBtn.style.display = 'none';
            }

            renderMyCards();
            renderHistoryTable(gs);
        });

        function renderCardUI(card, isSelectable = false, index = -1) {
            let div = document.createElement('div');
            let isRed = (card.suit === 'hearts' || card.suit === 'diamonds');
            div.className = 'card ' + (isRed ? 'red' : 'black');
            if (selectedIndices.includes(index)) div.classList.add('selected');

            let symbol = SUIT_SYMBOLS[card.suit] || '';
            div.innerHTML = '<div class="rank-top">' + card.rank + '</div>' +
                            '<div class="suit-center">' + symbol + '</div>' +
                            '<div class="rank-bottom">' + card.rank + '</div>';

            if (isSelectable) {
                div.onclick = () => {
                    if (selectedIndices.includes(index)) {
                        selectedIndices = selectedIndices.filter(i => i !== index);
                    } else {
                        selectedIndices.push(index);
                    }
                    renderMyCards();
                };
            }
            return div;
        }

        function renderMyCards() {
            let cardsDiv = document.getElementById('my-cards');
            cardsDiv.innerHTML = '';
            myCards.forEach((c, i) => {
                cardsDiv.appendChild(renderCardUI(c, true, i));
            });
        }

        function playSelectedCards() {
            if (selectedIndices.length === 0) return;
            socket.emit('playCards', selectedIndices);
            selectedIndices = [];
        }

        function playMaliutka() {
            if (myCards.length !== 5) return;
            socket.emit('playCards', [0, 1, 2, 3, 4]);
            selectedIndices = [];
        }

        function renderHistoryTable(gs) {
            let headTr = document.getElementById('history-head');
            let bodyTbody = document.getElementById('history-body');

            headTr.innerHTML = '<th>ხელი #</th><th>კოზირი</th>';
            gs.players.forEach(p => {
                let th = document.createElement('th');
                th.innerText = p.name;
                headTr.appendChild(th);
            });

            bodyTbody.innerHTML = '';
            gs.roundHistory.forEach(row => {
                let tr = document.createElement('tr');
                let tSymbol = SUIT_SYMBOLS[row.trump] || row.trump;
                tr.innerHTML = '<td>ხელი ' + row.handIndex + '</td><td><b>' + tSymbol + '</b></td>';
                
                gs.players.forEach(p => {
                    let pts = row.scores[p.id] !== undefined ? row.scores[p.id] : 0;
                    let td = document.createElement('td');
                    td.innerText = pts + ' ქულა';
                    tr.appendChild(td);
                });
                bodyTbody.appendChild(tr);
            });
        }
    </script>
</body>
</html>
    `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
