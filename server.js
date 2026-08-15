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

// მოჭრის შემოწმების ზუსტი წესი
function beatsPlay(leadPlay, challengePlay, trump) {
    let leadCards = leadPlay.cards;
    let challengeCards = challengePlay.cards;

    // მალიუტკა (5 კარტი) ჭრის ნებისმიერ ნაკლებ კარტს
    if (challengeCards.length === 5 && challengeCards.every(c => c.suit === challengeCards[0].suit)) {
        if (leadCards.length < 5) return true;
    }

    if (leadCards.length !== challengeCards.length) return false;

    let challengeSuit = challengeCards[0].suit;
    if (!challengeCards.every(c => c.suit === challengeSuit)) return false;

    let leadSuit = leadCards[0].suit;
    let isChallengeTrump = (trump !== 'no_trump' && challengeSuit === trump);
    let isLeadTrump = (trump !== 'no_trump' && leadSuit === trump);

    if (isChallengeTrump && !isLeadTrump) return true;
    if (isLeadTrump && !isChallengeTrump) return false;

    if (challengeSuit === leadSuit) {
        let sortedLead = [...leadCards].sort((a,b) => RANKS_ORDER.indexOf(b.rank) - RANKS_ORDER.indexOf(a.rank));
        let sortedChallenge = [...challengeCards].sort((a,b) => RANKS_ORDER.indexOf(b.rank) - RANKS_ORDER.indexOf(a.rank));

        for (let i = 0; i < sortedLead.length; i++) {
            if (RANKS_ORDER.indexOf(sortedChallenge[i].rank) <= RANKS_ORDER.indexOf(sortedLead[i].rank)) {
                return false;
            }
        }
        return true;
    }

    return false;
}

// გამარჯვებული ჩამოსვლის ზუსტი განსაზღვრა (შედარება მიმდევრობით)
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

    socket.on('playCards', ({ cardIndices, targetPlayerId }) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        let room = rooms[socket.roomId];
        let gs = room.gameState;

        if (!gs || gs.isProcessing || gs.gameOver) return;

        let activePlayer = room.players[gs.currentTurnIndex];
        let senderPlayer = room.players.find(p => p.id === socket.id);

        // ტესტერის (საბა123) რეჟიმის შემოწმება
        let actingPlayerId = activePlayer.id;
        if (senderPlayer && senderPlayer.isTester && targetPlayerId) {
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
            io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
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

                    // 🔄 კარტის შევსება წრეზე (Round-Robin)
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
    <title>ბურა ონლაინ / Pro Poker-Style Bura</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background: #0c0f17; color: white; margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
        
        #config-modal { position: fixed; inset: 0; background: rgba(12, 15, 23, 0.95); display: flex; justify-content: center; align-items: center; z-index: 100; }
        .card-box { background: #161c2e; padding: 30px; border-radius: 16px; border: 1px solid #2d3748; box-shadow: 0 10px 30px rgba(0,0,0,0.8); text-align: center; width: 360px; }
        .card-box h2 { margin-top: 0; color: #ffcc00; font-size: 24px; }
        .input-group { margin: 15px 0; text-align: left; }
        .input-group label { display: block; margin-bottom: 6px; font-size: 13px; color: #a0aec0; }
        .input-group input, .input-group select { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #2d3748; background: #0f1423; color: white; font-size: 15px; }
        .btn-action { width: 100%; padding: 12px; background: #00c853; border: none; border-radius: 8px; color: #fff; font-weight: bold; font-size: 16px; cursor: pointer; transition: 0.2s; margin-top: 10px; }
        .btn-action:hover { background: #00e676; }

        #tables-lobby { display: none; width: 100%; max-width: 480px; padding: 20px; flex-direction: column; gap: 12px; }
        .table-item { background: linear-gradient(180deg, #102a3a 0%, #081726 100%); border-radius: 14px; border: 1px solid #1c4863; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.5); cursor: pointer; transition: 0.2s; }
        .table-item:hover { border-color: #00e676; transform: translateY(-2px); }
        .table-stake { font-size: 20px; font-weight: bold; color: #fff; }
        .table-maxwin { font-size: 12px; color: #718096; margin-top: 2px; }
        .table-maxwin b { color: #fff; font-size: 14px; }
        .table-join-btn { width: 42px; height: 42px; background: #00c853; border-radius: 50%; display: flex; justify-content: center; align-items: center; color: white; font-size: 20px; box-shadow: 0 0 10px rgba(0,200,83,0.5); }

        #game-container { display: none; width: 100%; max-width: 1000px; padding: 15px; flex-direction: column; align-items: center; }
        
        .top-bar { width: 100%; background: #161c2e; border-radius: 12px; padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border: 1px solid #2d3748; flex-wrap: wrap; gap: 10px; }
        .info-badge { background: #0f1423; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 14px; border: 1px solid #2d3748; }
        
        #poker-table { width: 100%; min-height: 280px; background: #3d0c18; border: 12px solid #24130d; border-radius: 140px; box-shadow: inset 0 0 60px rgba(0,0,0,0.9), 0 10px 30px rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; gap: 20px; padding: 20px; margin: 10px 0; position: relative; }
        .table-indicator { position: absolute; top: 8px; width: 8px; height: 8px; background: #00ff66; border-radius: 50%; box-shadow: 0 0 8px #00ff66; }

        .table-play-group { display: flex; flex-direction: column; align-items: center; background: rgba(0,0,0,0.4); padding: 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); }
        .table-play-group.winning-play { border: 2px solid #ffcc00; box-shadow: 0 0 15px rgba(255, 204, 0, 0.6); }
        .player-tag { font-size: 11px; font-weight: bold; color: #a0aec0; margin-bottom: 4px; }
        .table-play-group.winning-play .player-tag { color: #ffcc00; }
        .cards-flex { display: flex; gap: 4px; }

        .card { width: 68px; height: 100px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 4px 10px rgba(0,0,0,0.6); display: flex; flex-direction: column; justify-content: space-between; padding: 6px; font-weight: bold; position: relative; transition: 0.2s; cursor: pointer; user-select: none; }
        .card:hover { transform: translateY(-8px); }
        .card.selected { border: 3px solid #ffcc00; transform: translateY(-14px); box-shadow: 0 0 15px rgba(255, 204, 0, 0.8); }
        
        .card.suit-spades { background: #1a2238; color: #fff; }     
        .card.suit-clubs { background: #263238; color: #80d8ff; }    
        .card.suit-diamonds { background: #2b000a; color: #ff5252; } 
        .card.suit-hearts { background: #330a18; color: #ff4081; }   

        .card .rank-top { font-size: 14px; line-height: 1; }
        .card .suit-center { font-size: 28px; text-align: center; line-height: 1; margin: auto; }
        .card .rank-bottom { font-size: 14px; text-align: right; line-height: 1; }

        .action-container { display: flex; gap: 15px; justify-content: center; align-items: center; margin-top: 15px; }
        #my-cards { display: flex; justify-content: center; gap: 10px; margin-top: 15px; min-height: 110px; flex-wrap: wrap; }
        #status-msg { font-size: 18px; font-weight: bold; color: #ffcc00; margin: 10px 0; min-height: 25px; }
        
        .play-btn { padding: 12px 35px; font-size: 16px; background: #00c853; border: none; border-radius: 20px; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; }
        .play-btn:disabled { background: #4a5568; color: #718096; cursor: not-allowed; }

        .leaderboard-box { width: 100%; background: #101625; border-radius: 12px; border: 1px solid #1e293b; padding: 15px; margin-top: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        .lb-table { width: 100%; border-collapse: collapse; text-align: center; font-size: 15px; }
        .lb-table th { color: #94a3b8; padding: 12px 8px; border-bottom: 1px solid #1e293b; font-weight: 600; }
        .lb-table td { padding: 12px 8px; border-bottom: 1px solid #1e293b; color: #f8fafc; font-weight: 500; }
        
        .bura-badge { background: #ef4444; color: white; padding: 4px 10px; border-radius: 6px; font-weight: bold; display: inline-block; }
        .sum-row { font-size: 18px; font-weight: bold; }
        .sum-row td { color: #f59e0b; border-top: 2px solid #334155; }

        .place-badge { padding: 6px 14px; border-radius: 8px; font-weight: bold; font-size: 13px; display: inline-block; }
        .place-1 { background: #f59e0b; color: #000; box-shadow: 0 0 10px rgba(245,158,11,0.5); }
        .place-2 { background: #94a3b8; color: #000; }
        .place-3 { background: #ea580c; color: #fff; }
        .place-4 { background: #334155; color: #94a3b8; border: 1px dashed #64748b; }

        /* Tester Control */
        #tester-control { display: none; background: #1e293b; padding: 10px 15px; border-radius: 10px; border: 1px solid #a855f7; margin-top: 10px; }
        #tester-control select { background: #0f172a; color: #fff; padding: 6px 10px; border-radius: 6px; border: 1px solid #a855f7; font-weight: bold; }
    </style>
</head>
<body>

    <div id="config-modal">
        <div class="card-box">
            <h2>♣ ბურა ონლაინ ♠</h2>
            <div class="input-group">
                <label>თქვენი სახელი (ტესტირებისთვის: საბა123):</label>
                <input type="text" id="player-name" value="საბა123" maxlength="12">
            </div>
            <div class="input-group">
                <label>მოთამაშეების რაოდენობა:</label>
                <select id="player-capacity">
                    <option value="2">2 მოთამაშე</option>
                    <option value="3" selected>3 მოთამაშე</option>
                    <option value="4">4 მოთამაშე</option>
                </select>
            </div>
            <div class="input-group">
                <label>პარტიების რაოდენობა:</label>
                <select id="player-parties">
                    <option value="1">1 პარტია (5 ხელი)</option>
                    <option value="2">2 პარტია (10 ხელი)</option>
                    <option value="4">4 პარტია (20 ხელი)</option>
                </select>
            </div>
            <button class="btn-action" onclick="showTablesLobby()">მაგიდების ნახვა</button>
        </div>
    </div>

    <div id="tables-lobby">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h3 style="margin:0; color:#ffcc00;">აირჩიეთ მაგიდა</h3>
            <div style="background:#1e293b; padding:6px 12px; border-radius:10px; font-weight:bold;">ბალანსი: <span style="color:#00e676;">100 USD</span></div>
        </div>
        
        <div class="table-item" onclick="joinSelectedTable(1)">
            <div><div class="table-stake">1 $</div><div class="table-maxwin">მაქს. მოგება <b>1000 $</b></div></div>
            <div class="table-join-btn">›</div>
        </div>
        <div class="table-item" onclick="joinSelectedTable(2)">
            <div><div class="table-stake">2 $</div><div class="table-maxwin">მაქს. მოგება <b>2000 $</b></div></div>
            <div class="table-join-btn">›</div>
        </div>
        <div class="table-item" onclick="joinSelectedTable(5)">
            <div><div class="table-stake">5 $</div><div class="table-maxwin">მაქს. მოგება <b>5000 $</b></div></div>
            <div class="table-join-btn">›</div>
        </div>
        <div class="table-item" onclick="joinSelectedTable(10)">
            <div><div class="table-stake">10 $</div><div class="table-maxwin">მაქს. მოგება <b>10000 $</b></div></div>
            <div class="table-join-btn">›</div>
        </div>
        <p id="lobby-wait-msg" style="display:none; text-align:center; color:#ffcc00; font-weight:bold;"></p>
    </div>

    <div id="game-container">
        <div class="top-bar">
            <div class="info-badge">ფონი: <b>$<span id="table-stake-disp">1</span></b></div>
            <div class="info-badge">პარტია: <b id="party-num">1</b>/<span id="target-parties">1</span></div>
            <div class="info-badge">ხელი: <b id="hand-num">1</b></div>
            <div class="info-badge">კოზირი: <span id="trump-display">-</span></div>
            <div class="info-badge">დასტაში: <b id="deck-count">-</b></div>
        </div>

        <!-- ტესტერის მართვის პანელი -->
        <div id="tester-control">
            <span style="color:#a855f7; font-weight:bold; margin-right:10px;">🧪 Tester Mode (საბა123):</span>
            <label>მართე მოთამაშე: </label>
            <select id="active-player-select" onchange="switchTesterPlayer()"></select>
        </div>

        <div id="status-msg">ველით მოთამაშეებს...</div>

        <div id="poker-table">
            <div class="table-indicator" style="left: 35%;"></div>
            <div class="table-indicator" style="right: 35%;"></div>
        </div>

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
        let latestGS = null;
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

        socket.on('waitingForPlayers', (data) => {
            document.getElementById('lobby-wait-msg').innerText = 'ველით მოთამაშეებს: (' + data.current + '/' + data.max + ')';
        });

        socket.on('gameStateUpdate', (gs) => {
            latestGS = gs;
            document.getElementById('tables-lobby').style.display = 'none';
            document.getElementById('game-container').style.display = 'flex';

            document.getElementById('table-stake-disp').innerText = gs.stake;
            document.getElementById('party-num').innerText = gs.partyNum;
            document.getElementById('target-parties').innerText = gs.targetParties;
            document.getElementById('hand-num').innerText = gs.handIndex;
            document.getElementById('deck-count').innerText = gs.deckCount;
            document.getElementById('trump-display').innerText = SUIT_SYMBOLS[gs.trump] || gs.trump;

            let myPlayerObj = gs.players.find(p => p.id === myId);

            // ტესტერის პანელის გამოჩენა
            if (myPlayerObj && myPlayerObj.isTester) {
                document.getElementById('tester-control').style.display = 'block';
                let select = document.getElementById('active-player-select');
                
                if (select.children.length === 0) {
                    select.innerHTML = '';
                    gs.players.forEach(p => {
                        let opt = document.createElement('option');
                        opt.value = p.id;
                        opt.innerText = p.name;
                        select.appendChild(opt);
                    });
                    controlledPlayerId = myId;
                }
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

            // მაგიდის რენდერი
            let tableDiv = document.getElementById('poker-table');
            tableDiv.innerHTML = '<div class="table-indicator" style="left: 35%;"></div><div class="table-indicator" style="right: 35%;"></div>';
            
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
            if (latestGS) {
                socket.emit('gameStateUpdate', latestGS); // Trigger re-render
            }
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
                tr.innerHTML = '<td style="color:#00d2ff; font-weight:bold;">#' + row.handIndex + ' ✏️</td>';
                
                gs.players.forEach(p => {
                    let pts = row.scores[p.id] !== undefined ? row.scores[p.id] : 0;
                    let td = document.createElement('td');
                    if (pts === 0) {
                        td.innerHTML = '<span class="bura-badge">-120</span>';
                    } else {
                        td.innerText = pts;
                    }
                    tr.appendChild(td);
                });
                bodyTbody.appendChild(tr);
            });

            let sumTr = document.createElement('tr');
            sumTr.className = 'sum-row';
            sumTr.innerHTML = '<td style="color:#f59e0b;">ჯამი</td>';
            gs.players.forEach(p => {
                let td = document.createElement('td');
                td.innerText = p.totalPoints;
                sumTr.appendChild(td);
            });
            bodyTbody.appendChild(sumTr);

            let sortedPlayers = [...gs.players].sort((a,b) => b.totalPoints - a.totalPoints);
            let placeTr = document.createElement('tr');
            placeTr.innerHTML = '<td style="color:#94a3b8; font-weight:bold;">ადგილი</td>';

            gs.players.forEach(p => {
                let rankIndex = sortedPlayers.findIndex(sp => sp.id === p.id) + 1;
                let td = document.createElement('td');
                let badgeClass = 'place-' + rankIndex;
                td.innerHTML = '<span class="place-badge ' + badgeClass + '">' + rankIndex + '-ე ადგილი</span>';
                placeTr.appendChild(td);
            });
            bodyTbody.appendChild(placeTr);
        }
    </script>
</body>
</html>
    `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
