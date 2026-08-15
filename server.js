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
const TRUMP_ROTATION = ['spades', 'clubs', 'hearts', 'diamonds', 'no_trump'];

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

function createRoom(roomId, maxPlayers, targetParties, stake) {
    return {
        id: roomId,
        maxPlayers: parseInt(maxPlayers),
        targetParties: parseInt(targetParties),
        stake: parseFloat(stake),
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

function cardBeatsCard(leadCard, challengeCard, trump) {
    let isChallengeTrump = (trump !== 'no_trump' && challengeCard.suit === trump);
    let isLeadTrump = (trump !== 'no_trump' && leadCard.suit === trump);

    if (isChallengeTrump && !isLeadTrump) return true;
    if (!isChallengeTrump && isLeadTrump) return false;

    if (challengeCard.suit === leadCard.suit) {
        return RANKS_ORDER.indexOf(challengeCard.rank) > RANKS_ORDER.indexOf(leadCard.rank);
    }
    return false;
}

function beatsPlay(leadPlay, challengePlay, trump) {
    let leadCards = leadPlay.cards;
    let challengeCards = challengePlay.cards;

    if (challengeCards.length === 5 && challengeCards.every(c => c.suit === challengeCards[0].suit)) {
        if (leadCards.length < 5) return true;
    }

    if (leadCards.length !== challengeCards.length) return false;

    let sortedLead = [...leadCards].sort((a,b) => RANKS_ORDER.indexOf(b.rank) - RANKS_ORDER.indexOf(a.rank));
    let sortedChallenge = [...challengeCards].sort((a,b) => RANKS_ORDER.indexOf(b.rank) - RANKS_ORDER.indexOf(a.rank));

    for (let i = 0; i < sortedLead.length; i++) {
        if (!cardBeatsCard(sortedLead[i], sortedChallenge[i], trump)) {
            return false;
        }
    }
    return true;
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

    socket.on('joinTable', ({ name, capacity, parties, stake }) => {
        let maxP = parseInt(capacity) || 2;
        let targetParties = parseInt(parties) || 1;
        let tableStake = parseFloat(stake) || 1;
        let playerName = name.trim() || 'მოთამაშე';

        let availableRoom = Object.values(rooms).find(r => 
            r.maxPlayers === maxP && 
            r.targetParties === targetParties && 
            r.stake === tableStake &&
            r.players.length < maxP && 
            !r.gameState
        );

        if (!availableRoom) {
            let roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            availableRoom = createRoom(roomId, maxP, targetParties, tableStake);
            rooms[roomId] = availableRoom;
        }

        socket.roomId = availableRoom.id;
        let isTester = (playerName === 'საბა123');
        
        availableRoom.players.push({ 
            id: socket.id, 
            name: playerName, 
            balance: 100 - tableStake,
            isTester: isTester 
        });
        socket.join(availableRoom.id);

        if (isTester) {
            let botCount = 1;
            while (availableRoom.players.length < availableRoom.maxPlayers) {
                let botId = 'bot_' + botCount + '_' + Date.now();
                availableRoom.players.push({
                    id: botId,
                    name: 'ბოტი ' + botCount,
                    balance: 100,
                    isTester: false,
                    isBot: true
                });
                botCount++;
            }
        }

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

    socket.on('switchControlledPlayer', ({ targetPlayerId }) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        let room = rooms[socket.roomId];
        let sender = room.players.find(p => p.id === socket.id);
        
        if (sender && sender.isTester && room.gameState) {
            socket.emit('gameStateUpdate', getClientGameState(room, targetPlayerId));
        }
    });

    socket.on('playCards', ({ cardIndices, targetPlayerId }) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        let room = rooms[socket.roomId];
        let gs = room.gameState;

        if (!gs || gs.isProcessing || gs.gameOver) return;

        let activePlayer = room.players[gs.currentTurnIndex];
        let senderPlayer = room.players.find(p => p.id === socket.id);

        let actingPlayerId = activePlayer.id;

        if (senderPlayer && senderPlayer.isTester && targetPlayerId) {
            if (targetPlayerId !== activePlayer.id) {
                socket.emit('errorMessage', 'ახლა ' + activePlayer.name + '-ის სვლაა! გადართეთ მასზე.');
                return;
            }
            actingPlayerId = targetPlayerId;
        } else if (activePlayer.id !== socket.id) {
            return;
        }

        let playerCards = gs.playersCards[actingPlayerId];
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
            gs.playersCards[actingPlayerId] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: actingPlayerId, playerName: room.players.find(p=>p.id===actingPlayerId).name, cards: selectedCards });

            gs.currentTurnIndex = (gs.currentTurnIndex + 1) % room.players.length;
            broadcastGameState(room);
        } 
        else {
            if (!isMaliutka && selectedCards.length !== gs.leadCardCount) {
                socket.emit('errorMessage', 'უნდა ჩამოხვიდეთ ზუსტად ' + gs.leadCardCount + ' კარტი (ან მალიუტკა)!');
                return;
            }

            if (isMaliutka) gs.leadCardCount = 5;

            gs.playersCards[actingPlayerId] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: actingPlayerId, playerName: room.players.find(p=>p.id===actingPlayerId).name, cards: selectedCards });

            if (gs.table.length < room.players.length) {
                gs.currentTurnIndex = (gs.currentTurnIndex + 1) % room.players.length;
                broadcastGameState(room);
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

                broadcastGameState(room);

                setTimeout(() => {
                    gs.table = [];
                    gs.leadCardCount = null;

                    while (gs.deck.length > 0) {
                        let anyPlayerNeedsCard = room.players.some(p => gs.playersCards[p.id].length < 5);
                        if (!anyPlayerNeedsCard) break;

                        for (let step = 0; step < room.players.length; step++) {
                            let pIdx = (winnerIndex + step) % room.players.length;
                            let pId = room.players[pIdx].id;

                            if (gs.playersCards[pId].length < 5 && gs.deck.length > 0) {
                                gs.playersCards[pId].push(gs.deck.pop());
                            }
                        }
                    }

                    let allHandsEmpty = room.players.every(p => gs.playersCards[p.id].length === 0);
                    gs.isProcessing = false;

                    if (allHandsEmpty) {
                        finishHand(room);
                    } else {
                        broadcastGameState(room);
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

function broadcastGameState(room) {
    room.players.forEach(p => {
        io.to(p.id).emit('gameStateUpdate', getClientGameState(room, p.id));
    });
}

function finishHand(room) {
    let gs = room.gameState;
    let handScores = {};
    let minScore = Infinity;
    let minPlayerIndex = 0;

    room.players.forEach((p, idx) => {
        let pts = gs.takenCards[p.id].reduce((sum, c) => sum + c.value, 0);
        handScores[p.id] = pts;
        gs.totalScores[p.id] = (gs.totalScores[p.id] || 0) + (pts === 0 ? -120 : pts);

        if (pts < minScore) {
            minScore = pts;
            minPlayerIndex = idx;
        }
    });

    gs.roundHistory.push({
        handIndex: gs.handIndex,
        trump: gs.trump,
        scores: handScores
    });

    let totalMaxHands = room.targetParties * 5;

    if (gs.handIndex >= totalMaxHands) {
        gs.gameOver = true;
        let sorted = [...room.players].sort((a,b) => (gs.totalScores[b.id]||0) - (gs.totalScores[a.id]||0));
        let winner = sorted[0];
        let totalPrize = room.stake * room.players.length;
        winner.balance += totalPrize;

        broadcastGameState(room);
    } else {
        let nextLeaderIndex = (minPlayerIndex + 1) % room.players.length;
        gs.nextRoundLeaderIndex = nextLeaderIndex;
        room.gameState = startNewHand(room, gs);
        broadcastGameState(room);
    }
}

function getClientGameState(room, forPlayerId) {
    let gs = room.gameState;
    let winningIndex = getWinningPlayIndex(gs.table, gs.trump);

    let playersSummary = room.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        balance: p.balance,
        isTester: p.isTester,
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
        stake: room.stake,
        players: playersSummary,
        playersCards: gs.playersCards,
        viewingPlayerId: forPlayerId,
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
    <title>ბურა ონლაინ / VIP Bura Pro</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
        body { background: radial-gradient(circle at center, #1b0f1a 0%, #070408 100%); color: white; margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        
        #config-modal { position: fixed; inset: 0; background: rgba(5, 3, 7, 0.85); backdrop-filter: blur(12px); display: flex; justify-content: center; align-items: center; z-index: 100; }
        
        .card-box { 
            background: rgba(26, 18, 30, 0.7); 
            padding: 35px 30px; 
            border-radius: 24px; 
            border: 1px solid rgba(255, 215, 0, 0.25); 
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8), inset 0 0 15px rgba(255, 215, 0, 0.05); 
            text-align: center; 
            width: 380px; 
        }

        .card-box h2 { margin: 0 0 25px 0; color: #ffd700; font-size: 26px; text-shadow: 0 0 12px rgba(255, 215, 0, 0.4); }
        .input-group { margin: 18px 0; text-align: left; }
        .input-group label { display: block; margin-bottom: 8px; font-size: 13px; color: #d1d5db; font-weight: 600; text-transform: uppercase; }
        
        .input-group input, .input-group select { 
            width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); 
            background: rgba(10, 6, 14, 0.7); color: #fff; font-size: 15px; outline: none;
        }

        .btn-action { 
            width: 100%; padding: 14px; background: linear-gradient(135deg, #ffd700 0%, #ff8c00 100%); 
            border: none; border-radius: 12px; color: #000; font-weight: 800; font-size: 16px; cursor: pointer; margin-top: 15px; 
        }

        #tables-lobby { display: none; width: 100%; max-width: 480px; padding: 20px; flex-direction: column; gap: 14px; }
        
        .table-item { 
            background: rgba(30, 20, 35, 0.6); border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.1); 
            padding: 16px 22px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; 
        }

        .table-stake { font-size: 22px; font-weight: 800; color: #ffd700; }
        .table-maxwin { font-size: 13px; color: #9ca3af; margin-top: 2px; }
        .table-join-btn { width: 42px; height: 42px; background: linear-gradient(135deg, #ffd700 0%, #ff8c00 100%); border-radius: 50%; display: flex; justify-content: center; align-items: center; color: #000; font-size: 22px; font-weight: bold; }

        #game-container { display: none; width: 100%; max-width: 1000px; padding: 15px; flex-direction: column; align-items: center; }
        .top-bar { width: 100%; background: rgba(22, 15, 28, 0.8); border-radius: 14px; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.1); flex-wrap: wrap; gap: 10px; }
        .info-badge { background: rgba(10, 6, 14, 0.8); padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; border: 1px solid rgba(255,215,0,0.3); color: #ffd700; }
        
        #poker-table { width: 100%; min-height: 280px; background: #3d0c18; border: 12px solid #24130d; border-radius: 140px; box-shadow: inset 0 0 60px rgba(0,0,0,0.9); display: flex; justify-content: center; align-items: center; gap: 20px; padding: 20px; margin: 10px 0; }

        .table-play-group { display: flex; flex-direction: column; align-items: center; background: rgba(0,0,0,0.4); padding: 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); }
        .table-play-group.winning-play { border: 2px solid #ffd700; box-shadow: 0 0 15px rgba(255, 215, 0, 0.6); }
        .player-tag { font-size: 11px; font-weight: bold; color: #a0aec0; margin-bottom: 4px; }
        .cards-flex { display: flex; gap: 4px; }

        .card { width: 68px; height: 100px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 4px 10px rgba(0,0,0,0.6); display: flex; flex-direction: column; justify-content: space-between; padding: 6px; font-weight: bold; cursor: pointer; user-select: none; }
        .card.selected { border: 3px solid #ffd700; transform: translateY(-14px); box-shadow: 0 0 15px rgba(255, 215, 0, 0.8); }
        
        .card.suit-spades { background: #1a2238; color: #fff; }     
        .card.suit-clubs { background: #263238; color: #80d8ff; }    
        .card.suit-diamonds { background: #2b000a; color: #ff5252; } 
        .card.suit-hearts { background: #330a18; color: #ff4081; }   

        .card .rank-top { font-size: 14px; line-height: 1; }
        .card .suit-center { font-size: 28px; text-align: center; line-height: 1; margin: auto; }
        .card .rank-bottom { font-size: 14px; text-align: right; line-height: 1; }

        .action-container { display: flex; gap: 15px; justify-content: center; align-items: center; margin-top: 15px; }
        #my-cards { display: flex; justify-content: center; gap: 10px; margin-top: 15px; min-height: 110px; flex-wrap: wrap; }
        #status-msg { font-size: 18px; font-weight: bold; color: #ffd700; margin: 10px 0; min-height: 25px; }
        
        .play-btn { padding: 12px 35px; font-size: 16px; background: linear-gradient(135deg, #ffd700 0%, #ff8c00 100%); border: none; border-radius: 20px; color: #000; font-weight: bold; cursor: pointer; }
        .play-btn:disabled { background: #4a5568; color: #718096; cursor: not-allowed; }

        .leaderboard-box { width: 100%; background: rgba(16, 22, 37, 0.8); border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); padding: 15px; margin-top: 20px; }
        .lb-table { width: 100%; border-collapse: collapse; text-align: center; font-size: 15px; }
        .lb-table th { color: #94a3b8; padding: 12px 8px; border-bottom: 1px solid #1e293b; }
        .lb-table td { padding: 12px 8px; border-bottom: 1px solid #1e293b; color: #f8fafc; }

        #tester-control { display: none; background: rgba(30, 20, 45, 0.9); padding: 12px 20px; border-radius: 12px; border: 1px solid #a855f7; margin-top: 10px; }
        #tester-control select { background: #0f172a; color: #fff; padding: 8px 12px; border-radius: 8px; border: 1px solid #a855f7; font-weight: bold; }
    </style>
</head>
<body>

    <div id="config-modal">
        <div class="card-box">
            <h2>♠ BURA VIP CLUB ♣</h2>
            <div class="input-group">
                <label>თქვენი სახელი (ტესტირებისთვის: საბა123):</label>
                <input type="text" id="player-name" value="საბა123" maxlength="12">
            </div>
            <div class="input-group">
                <label>მოთამაშეები:</label>
                <select id="player-capacity">
                    <option value="2">2 მოთამაშე</option>
                    <option value="3" selected>3 მოთამაშე</option>
                    <option value="4">4 მოთამაშე</option>
                </select>
            </div>
            <div class="input-group">
                <label>პარტიები:</label>
                <select id="player-parties">
                    <option value="1">1 პარტია (5 ხელი)</option>
                    <option value="2">2 პარტია (10 ხელი)</option>
                </select>
            </div>
            <button class="btn-action" onclick="showTablesLobby()">მაგიდის არჩევა ›</button>
        </div>
    </div>

    <div id="tables-lobby">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h3 style="margin:0; color:#ffd700;">აირჩიეთ ფონი</h3>
        </div>
        
        <div class="table-item" onclick="joinSelectedTable(1)">
            <div><div class="table-stake">1 $</div><div class="table-maxwin">მოგება: <b>1000 $</b></div></div>
            <div class="table-join-btn">›</div>
        </div>
        <div class="table-item" onclick="joinSelectedTable(2)">
            <div><div class="table-stake">2 $</div><div class="table-maxwin">მოგება: <b>2000 $</b></div></div>
            <div class="table-join-btn">›</div>
        </div>
        <p id="lobby-wait-msg" style="display:none; text-align:center; color:#ffd700; font-weight:bold;"></p>
    </div>

    <div id="game-container">
        <div class="top-bar">
            <div class="info-badge">ფონი: <b>$<span id="table-stake-disp">1</span></b></div>
            <div class="info-badge">პარტია: <b id="party-num">1</b>/<span id="target-parties">1</span></div>
            <div class="info-badge">ხელი: <b id="hand-num">1</b></div>
            <div class="info-badge">კოზირი: <span id="trump-display">-</span></div>
            <div class="info-badge">დასტაში: <b id="deck-count">-</b></div>
        </div>

        <div id="tester-control">
            <span style="color:#a855f7; font-weight:bold; margin-right:10px;">🧪 ტესტერის რეჟიმი (საბა123):</span>
            <label>მართე მოთამაშე: </label>
            <select id="active-player-select" onchange="switchTesterPlayer()"></select>
        </div>

        <div id="status-msg">ველით მოთამაშეებს...</div>

        <div id="poker-table"></div>

        <h3 id="cards-owner-title">ჩემი კარტები</h3>
        <div id="my-cards"></div>
        
        <div class="action-container">
            <button id="play-btn" class="play-btn" onclick="playSelectedCards()" disabled>ჩამოსვლა</button>
        </div>

        <div class="leaderboard-box">
            <table class="lb-table">
                <thead><tr id="lb-head"><th>ხელი</th></tr></thead>
                <tbody id="lb-body"></tbody>
            </table>
        </div>
    </div>

    <script>
        const socket = io();
        let myCards = [];
        let selectedIndices = [];
        let myId = null;
        let controlledPlayerId = null;

        const SUIT_SYMBOLS = {
            'spades': '♠', 'clubs': '♣', 'hearts': '♥', 'diamonds': '♦', 'no_trump': 'ბეზი'
        };

        socket.on('connect', () => { myId = socket.id; });
        socket.on('errorMessage', (msg) => { alert(msg); });
        socket.on('playerLeft', () => { alert('მოთამაშე გავიდა.'); location.reload(); });

        function showTablesLobby() {
            document.getElementById('config-modal').style.display = 'none';
            document.getElementById('tables-lobby').style.display = 'flex';
        }

        function joinSelectedTable(stake) {
            let name = document.getElementById('player-name').value;
            let capacity = document.getElementById('player-capacity').value;
            let parties = document.getElementById('player-parties').value;
            
            socket.emit('joinTable', { name, capacity, parties, stake });
            document.getElementById('lobby-wait-msg').style.display = 'block';
            document.getElementById('lobby-wait-msg').innerText = 'ველით სხვა მოთამაშეებს...';
        }

        socket.on('gameStateUpdate', (gs) => {
            document.getElementById('tables-lobby').style.display = 'none';
            document.getElementById('game-container').style.display = 'flex';

            document.getElementById('table-stake-disp').innerText = gs.stake;
            document.getElementById('party-num').innerText = gs.partyNum;
            document.getElementById('target-parties').innerText = gs.targetParties;
            document.getElementById('hand-num').innerText = gs.handIndex;
            document.getElementById('deck-count').innerText = gs.deckCount;
            document.getElementById('trump-display').innerText = SUIT_SYMBOLS[gs.trump] || gs.trump;

            let meObj = gs.players.find(p => p.id === myId);

            if (meObj && meObj.isTester) {
                document.getElementById('tester-control').style.display = 'block';
                let select = document.getElementById('active-player-select');
                
                select.innerHTML = '';
                gs.players.forEach(p => {
                    let opt = document.createElement('option');
                    opt.value = p.id;
                    opt.innerText = p.name;
                    if (p.id === (controlledPlayerId || myId)) opt.selected = true;
                    select.appendChild(opt);
                });
                if (!controlledPlayerId) controlledPlayerId = myId;
            }

            let activeTargetId = controlledPlayerId || myId;
            let activePlayer = gs.players[gs.currentTurnIndex];
            let isTargetTurn = (activePlayer && activePlayer.id === activeTargetId) && !gs.isProcessing && !gs.gameOver;

            if (gs.gameOver) {
                let winner = [...gs.players].sort((a,b) => b.totalPoints - a.totalPoints)[0];
                document.getElementById('status-msg').innerText = "🏆 თამაში დასრულდა! გამარჯვებულია: " + winner.name;
            } else if (gs.isProcessing) {
                document.getElementById('status-msg').innerText = "ითვლება სლიკი...";
            } else if (isTargetTurn) {
                document.getElementById('status-msg').innerText = "სვლა ეკუთვნის: " + activePlayer.name;
            } else {
                document.getElementById('status-msg').innerText = (activePlayer ? activePlayer.name : '') + "-ის სვლაა...";
            }

            document.getElementById('play-btn').disabled = !isTargetTurn;

            let tableDiv = document.getElementById('poker-table');
            tableDiv.innerHTML = '';
            
            gs.table.forEach(play => {
                let groupDiv = document.createElement('div');
                groupDiv.className = 'table-play-group ' + (play.isWinning ? 'winning-play' : '');
                
                let tag = document.createElement('div');
                tag.className = 'player-tag';
                tag.innerText = play.playerName + (play.isWinning ? ' ⭐' : '');
                groupDiv.appendChild(tag);

                let cardsFlex = document.createElement('div');
                cardsFlex.className = 'cards-flex';
                play.cards.forEach(c => {
                    cardsFlex.appendChild(renderCardUI(c));
                });
                groupDiv.appendChild(cardsFlex);

                tableDiv.appendChild(groupDiv);
            });

            myCards = gs.playersCards[activeTargetId] || [];
            selectedIndices = selectedIndices.filter(i => i < myCards.length);
            
            let targetPlayerObj = gs.players.find(p => p.id === activeTargetId);
            document.getElementById('cards-owner-title').innerText = (targetPlayerObj ? targetPlayerObj.name : 'ჩემი') + "-ს კარტები";

            renderMyCards();
            renderLeaderboardTable(gs);
        });

        function switchTesterPlayer() {
            controlledPlayerId = document.getElementById('active-player-select').value;
            selectedIndices = [];
            socket.emit('switchControlledPlayer', { targetPlayerId: controlledPlayerId });
        }

        function renderCardUI(card, isSelectable = false, index = -1) {
            let div = document.createElement('div');
            div.className = 'card suit-' + card.suit;
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
            socket.emit('playCards', { 
                cardIndices: selectedIndices, 
                targetPlayerId: controlledPlayerId || myId 
            });
            selectedIndices = [];
        }

        function renderLeaderboardTable(gs) {
            let headTr = document.getElementById('lb-head');
            let bodyTbody = document.getElementById('lb-body');

            headTr.innerHTML = '<th>ხელი</th>';
            gs.players.forEach(p => {
                let th = document.createElement('th');
                th.innerText = p.name;
                headTr.appendChild(th);
            });

            bodyTbody.innerHTML = '';

            gs.roundHistory.forEach(row => {
                let tr = document.createElement('tr');
                tr.innerHTML = '<td style="color:#ffd700; font-weight:bold;">#' + row.handIndex + '</td>';
                
                gs.players.forEach(p => {
                    let pts = row.scores[p.id] !== undefined ? row.scores[p.id] : 0;
                    let td = document.createElement('td');
                    td.innerText = pts === 0 ? '-120' : pts;
                    tr.appendChild(td);
                });
                bodyTbody.appendChild(tr);
            });

            let sumTr = document.createElement('tr');
            sumTr.innerHTML = '<td style="color:#ffd700; font-weight:bold;">ჯამი</td>';
            gs.players.forEach(p => {
                let td = document.createElement('td');
                td.innerText = p.totalPoints;
                td.style.fontWeight = 'bold';
                sumTr.appendChild(td);
            });
            bodyTbody.appendChild(sumTr);
        }
    </script>
</body>
</html>
    `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
