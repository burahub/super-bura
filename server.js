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
const TRUMP_ROTATION = ['spades', 'clubs', 'hearts', 'no_trump'];

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

function createRoom(roomId, maxPlayers) {
    return {
        id: roomId,
        maxPlayers: parseInt(maxPlayers),
        players: [],
        gameState: null
    };
}

function startNewGame(room, previousGame = null) {
    let deck = createDeck();
    let playersCards = {};
    let takenCards = {};
    let gameScores = {};

    room.players.forEach((p) => {
        playersCards[p.id] = deck.splice(0, 5);
        takenCards[p.id] = [];
        gameScores[p.id] = previousGame ? (previousGame.gameScores[p.id] || 0) : 0;
    });

    let party = previousGame ? previousGame.party : 1;
    let roundNum = previousGame ? previousGame.roundNum + 1 : 1;
    
    let trumpIndex = (roundNum - 1) % 4;
    let currentTrump = TRUMP_ROTATION[trumpIndex];

    let startLeaderIndex = 0;
    if (previousGame && previousGame.nextRoundLeaderIndex !== undefined) {
        startLeaderIndex = previousGame.nextRoundLeaderIndex;
    }

    return {
        deck,
        playersCards,
        takenCards,
        gameScores,
        currentTurnIndex: startLeaderIndex,
        table: [],
        trump: currentTrump,
        party: party,
        roundNum: roundNum,
        leadCardCount: null,
        isProcessing: false
    };
}

function beatsPlay(leadPlay, challengePlay, trump) {
    let leadCards = leadPlay.cards;
    let challengeCards = challengePlay.cards;

    // მალიუტკა ჭრის ჩვეულებრივ ნაკლებკარტიან სვლას
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

io.on('connection', (socket) => {

    socket.on('joinGame', ({ name, capacity }) => {
        let maxP = parseInt(capacity) || 2;
        let playerName = name.trim() || 'მოთამაშე';

        let availableRoom = Object.values(rooms).find(r => r.maxPlayers === maxP && r.players.length < maxP && !r.gameState);

        if (!availableRoom) {
            let roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            availableRoom = createRoom(roomId, maxP);
            rooms[roomId] = availableRoom;
        }

        socket.roomId = availableRoom.id;
        availableRoom.players.push({ id: socket.id, name: playerName });
        socket.join(availableRoom.id);

        if (availableRoom.players.length === availableRoom.maxPlayers) {
            availableRoom.gameState = startNewGame(availableRoom);
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

        if (!gs || gs.isProcessing) return;

        let activePlayer = room.players[gs.currentTurnIndex];
        if (activePlayer.id !== socket.id) return;

        let playerCards = gs.playersCards[socket.id];
        let selectedCards = cardIndices.map(i => playerCards[i]).filter(Boolean);

        if (selectedCards.length === 0 || selectedCards.length !== cardIndices.length) return;

        let isMaliutka = (selectedCards.length === 5) && selectedCards.every(c => c.suit === selectedCards[0].suit);

        // პირველი სვლა მაგიდაზე
        if (gs.table.length === 0) {
            let firstSuit = selectedCards[0].suit;
            let isSameSuit = selectedCards.every(c => c.suit === firstSuit);
            if (!isSameSuit) {
                socket.emit('errorMessage', 'ჩამომსვლელს შეუძლია მხოლოდ ერთი ცვეტის კარტების დადება!');
                return;
            }

            gs.leadCardCount = selectedCards.length;
            gs.playersCards[socket.id] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: socket.id, cards: selectedCards });

            gs.currentTurnIndex = (gs.currentTurnIndex + 1) % room.players.length;
            io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
        } 
        // პასუხი (მოჭრა/ჩაგდება/მალიუტკა)
        else {
            if (!isMaliutka && selectedCards.length !== gs.leadCardCount) {
                socket.emit('errorMessage', 'უნდა ჩამოხვიდეთ ზუსტად ' + gs.leadCardCount + ' კარტი (ან მალიუტკა)!');
                return;
            }

            // თუ მალიუტკა ჩამოვიდა, ახალი ლიდერ-რაოდენობა ხდება 5
            if (isMaliutka) {
                gs.leadCardCount = 5;
            }

            gs.playersCards[socket.id] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: socket.id, cards: selectedCards });

            if (gs.table.length < room.players.length) {
                gs.currentTurnIndex = (gs.currentTurnIndex + 1) % room.players.length;
                io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
            } else {
                let winningPlay = gs.table[0];

                for (let i = 1; i < gs.table.length; i++) {
                    if (beatsPlay(winningPlay, gs.table[i], gs.trump)) {
                        winningPlay = gs.table[i];
                    }
                }

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
                        finishRound(room);
                    } else {
                        io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
                    }
                }, 1800);
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

function finishRound(room) {
    let gs = room.gameState;
    let minScore = Infinity;
    let minPlayerIndex = 0;
    let maxScore = -1;
    let roundWinnerId = null;

    room.players.forEach((p, idx) => {
        let pts = gs.takenCards[p.id].reduce((sum, c) => sum + c.value, 0);

        if (pts < minScore) {
            minScore = pts;
            minPlayerIndex = idx;
        }

        if (pts > maxScore) {
            maxScore = pts;
            roundWinnerId = p.id;
        }
    });

    if (roundWinnerId) {
        gs.gameScores[roundWinnerId] = (gs.gameScores[roundWinnerId] || 0) + 1;
    }

    let nextLeaderIndex = (minPlayerIndex + 1) % room.players.length;
    gs.nextRoundLeaderIndex = nextLeaderIndex;

    room.gameState = startNewGame(room, gs);
    io.to(room.id).emit('gameStateUpdate', getClientGameState(room));
}

function getClientGameState(room) {
    let gs = room.gameState;
    let playersSummary = room.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        cardCount: gs.playersCards[p.id] ? gs.playersCards[p.id].length : 0,
        takenCount: gs.takenCards[p.id] ? gs.takenCards[p.id].length : 0,
        roundPoints: gs.takenCards[p.id] ? gs.takenCards[p.id].reduce((a, b) => a + b.value, 0) : 0,
        gameScore: gs.gameScores[p.id] || 0,
        isCurrent: idx === gs.currentTurnIndex
    }));

    return {
        table: gs.table,
        trump: gs.trump,
        party: gs.party,
        roundNum: gs.roundNum,
        players: playersSummary,
        playersCards: gs.playersCards,
        currentTurnIndex: gs.currentTurnIndex,
        isProcessing: gs.isProcessing,
        leadCardCount: gs.leadCardCount,
        deckCount: gs.deck.length
    };
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ka">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ბურა ონლაინ / Bura Card Game</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background: #0b2416; color: white; margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
        
        #lobby { position: fixed; inset: 0; background: rgba(5, 15, 10, 0.95); display: flex; justify-content: center; align-items: center; z-index: 100; }
        .lobby-card { background: #143d26; padding: 30px; border-radius: 16px; border: 2px solid #ffcc00; box-shadow: 0 10px 30px rgba(0,0,0,0.8); text-align: center; width: 340px; }
        .lobby-card h2 { margin-top: 0; color: #ffcc00; }
        .input-group { margin: 15px 0; text-align: left; }
        .input-group label { display: block; margin-bottom: 5px; font-size: 14px; color: #ccc; }
        .input-group input, .input-group select { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #2a6642; background: #0b2416; color: white; font-size: 16px; }
        .btn-start { width: 100%; padding: 12px; background: #ffcc00; border: none; border-radius: 8px; color: #000; font-weight: bold; font-size: 18px; cursor: pointer; transition: 0.2s; margin-top: 10px; }
        .btn-start:hover { background: #ffe066; }

        #game-container { display: none; width: 100%; max-width: 1000px; padding: 15px; flex-direction: column; align-items: center; }
        
        .top-bar { width: 100%; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); border-radius: 12px; border: 1px solid rgba(255,204,0,0.3); padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
        .info-badge { background: rgba(255,255,255,0.1); padding: 6px 14px; border-radius: 20px; font-weight: 500; font-size: 15px; }
        
        .leaderboard { width: 100%; background: rgba(0,0,0,0.4); border-radius: 10px; padding: 10px; margin-bottom: 15px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
        .player-card { background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; border-left: 4px solid #555; text-align: left; }
        .player-card.active { border-left-color: #ffcc00; background: rgba(255, 204, 0, 0.15); }
        .player-card .p-name { font-weight: bold; font-size: 15px; color: #fff; }
        .player-card .p-stats { font-size: 13px; color: #bbb; margin-top: 3px; }

        #poker-table { width: 100%; min-height: 220px; background: radial-gradient(circle, #1a5333 0%, #0d2b1a 100%); border: 8px solid #3d2612; border-radius: 120px; box-shadow: inset 0 0 40px rgba(0,0,0,0.8), 0 10px 25px rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; gap: 15px; padding: 20px; margin: 10px 0; position: relative; }
        .card-group { display: flex; gap: 5px; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 10px; border: 1px dashed rgba(255,255,255,0.2); }

        .card { width: 75px; height: 110px; background: #ffffff; border-radius: 8px; border: 1px solid #ccc; box-shadow: 0 4px 10px rgba(0,0,0,0.4); display: flex; flex-direction: column; justify-content: space-between; padding: 6px; font-weight: bold; position: relative; transition: all 0.2s ease; cursor: pointer; user-select: none; }
        .card:hover { transform: translateY(-8px); box-shadow: 0 8px 18px rgba(0,0,0,0.5); }
        .card.selected { border: 3px solid #ffcc00; transform: translateY(-14px); box-shadow: 0 0 15px rgba(255, 204, 0, 0.9); }
        .card.red { color: #d32f2f; }
        .card.black { color: #1a1a1a; }
        .card .rank-top { font-size: 15px; line-height: 1; }
        .card .suit-center { font-size: 32px; text-align: center; line-height: 1; margin: auto; }
        .card .rank-bottom { font-size: 15px; text-align: right; line-height: 1; }

        .action-container { display: flex; gap: 15px; justify-content: center; align-items: center; margin-top: 15px; }
        #my-cards { display: flex; justify-content: center; gap: 12px; margin-top: 15px; min-height: 125px; flex-wrap: wrap; }
        #status-msg { font-size: 20px; font-weight: bold; color: #ffcc00; margin: 10px 0; min-height: 28px; }
        
        .play-btn { padding: 12px 35px; font-size: 18px; background: linear-gradient(180deg, #ffcc00 0%, #e6b800 100%); border: none; border-radius: 25px; color: #000; font-weight: bold; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.4); transition: 0.2s; }
        .play-btn:disabled { background: #555; color: #888; cursor: not-allowed; box-shadow: none; }

        /* Maliutka Button */
        .maliutka-btn { padding: 12px 25px; font-size: 18px; background: linear-gradient(180deg, #ff4e50 0%, #f9d423 100%); border: 2px solid #fff; border-radius: 25px; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.8); font-weight: bold; cursor: pointer; box-shadow: 0 0 15px rgba(255, 78, 80, 0.8); animation: pulse 1.5s infinite; }
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.06); }
            100% { transform: scale(1); }
        }

        .red-text { color: #ff5252; font-weight: bold; }
        .black-text { color: #ffffff; font-weight: bold; }
    </style>
</head>
<body>

    <div id="lobby">
        <div class="lobby-card">
            <h2>♣ ბურა ონლაინ ♠</h2>
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
            <button class="btn-start" onclick="joinLobby()">თამაშის დაწყება</button>
            <p id="lobby-wait" style="display:none; color:#ffcc00; margin-top:15px;"></p>
        </div>
    </div>

    <div id="game-container">
        <div class="top-bar">
            <div class="info-badge">დარიგება: <b id="round-num">1</b></div>
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
            socket.emit('joinGame', { name, capacity });
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

            document.getElementById('round-num').innerText = gs.roundNum;
            document.getElementById('deck-count').innerText = gs.deckCount;

            let trumpText = SUIT_SYMBOLS[gs.trump] || gs.trump;
            let trumpSpan = document.getElementById('trump-display');
            if (gs.trump === 'hearts' || gs.trump === 'diamonds') {
                trumpSpan.innerHTML = '<span class="red-text">' + trumpText + '</span>';
            } else {
                trumpSpan.innerHTML = '<span class="black-text">' + trumpText + '</span>';
            }

            let lbDiv = document.getElementById('leaderboard');
            lbDiv.innerHTML = '';
            gs.players.forEach(p => {
                let pDiv = document.createElement('div');
                pDiv.className = 'player-card ' + (p.isCurrent ? 'active' : '');
                let isMe = p.id === myId ? ' (შენ)' : '';
                pDiv.innerHTML = '<div class="p-name">' + p.name + isMe + '</div>' +
                                 '<div class="p-stats">ქულა: <b>' + p.roundPoints + '</b> | წაღებული: ' + p.takenCount + ' | მოგება: ' + p.gameScore + '</div>';
                lbDiv.appendChild(pDiv);
            });

            let activePlayer = gs.players[gs.currentTurnIndex];
            let isMyTurn = (activePlayer && activePlayer.id === myId) && !gs.isProcessing;
            
            if (gs.isProcessing) {
                document.getElementById('status-msg').innerText = "ითვლება სლიკი...";
            } else if (isMyTurn) {
                document.getElementById('status-msg').innerText = "თქვენი სვლაა!";
            } else {
                document.getElementById('status-msg').innerText = (activePlayer ? activePlayer.name : '') + "-ის სვლაა...";
            }

            document.getElementById('play-btn').disabled = !isMyTurn;

            let tableDiv = document.getElementById('poker-table');
            tableDiv.innerHTML = '';
            gs.table.forEach(group => {
                let gDiv = document.createElement('div');
                gDiv.className = 'card-group';
                group.cards.forEach(c => {
                    gDiv.appendChild(renderCardUI(c));
                });
                tableDiv.appendChild(gDiv);
            });

            myCards = gs.playersCards[myId] || [];
            selectedIndices = selectedIndices.filter(i => i < myCards.length);

            // შემოწმება: აქვს თუ არა მოთამაშეს მალიუტკა ხელში (5 ერთი ცვეტის)
            let hasMaliutka = myCards.length === 5 && myCards.every(c => c.suit === myCards[0].suit);
            let maliutkaBtn = document.getElementById('maliutka-btn');
            
            if (hasMaliutka && isMyTurn) {
                maliutkaBtn.style.display = 'inline-block';
            } else {
                maliutkaBtn.style.display = 'none';
            }

            renderMyCards();
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
            let allIndices = [0, 1, 2, 3, 4];
            socket.emit('playCards', allIndices);
            selectedIndices = [];
        }
    </script>
</body>
</html>
    `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
