const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SUITS = ['♠', '♣', '♦', '♥'];
const RANKS = ['6', '7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const POINTS = { '6': 0, '7': 0, '8': 0, '9': 0, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };

let roomState = {
    players: [],
    deck: [],
    trumpCard: null,
    tableCards: [],
    gameStarted: false,
    maxPlayers: 4,
    currentTurnIndex: 0,
    roundStartIndex: 0
};

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let rank of RANKS) {
            deck.push({ suit, rank, pt: POINTS[rank] });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

// ---------------- HTML FRONTEND SERVING ----------------
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ka">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>სუპერ ბურა - MultiPlayer</title>
    <script src="/socket.io/socket.io.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; font-family: 'Poppins', sans-serif; }
        body { background: #0f172a; color: white; margin: 0; padding: 15px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        
        h1 { font-size: 26px; margin-bottom: 10px; color: #f59e0b; text-shadow: 0 0 10px rgba(245, 158, 11, 0.3); }

        .lobby { background: #1e293b; padding: 30px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; text-align: center; width: 100%; max-width: 400px; margin-top: 50px; }
        .lobby input { padding: 12px; width: 100%; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: white; font-size: 16px; margin-bottom: 15px; text-align: center; }
        
        .btn { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; border: none; padding: 12px 24px; font-weight: 700; border-radius: 8px; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 4px 12px rgba(217, 119, 6, 0.4); }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 15px rgba(217, 119, 6, 0.6); }
        .btn:disabled { background: #64748b; cursor: not-allowed; transform: none; box-shadow: none; }

        #gameLayout { display: flex; gap: 20px; width: 100%; max-width: 1100px; flex-wrap: wrap; justify-content: center; }
        
        /* Poker Table */
        #pokerTable { flex: 1; min-width: 650px; background: radial-gradient(circle, #15803d 0%, #166534 70%, #052e16 100%); border: 12px solid #78350f; border-radius: 120px; box-shadow: inset 0 0 50px #000, 0 20px 40px rgba(0,0,0,0.8); padding: 20px; position: relative; min-height: 520px; display: flex; flex-direction: column; justify-content: space-between; align-items: center; }

        /* Players Spots */
        .players-container { display: flex; justify-content: space-around; width: 100%; }
        .player-spot { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(5px); border: 2px solid #334155; padding: 10px 15px; border-radius: 12px; text-align: center; min-width: 120px; transition: all 0.3s; }
        .player-spot.active { border-color: #f59e0b; box-shadow: 0 0 15px #f59e0b; transform: scale(1.05); }
        .player-spot .p-name { font-weight: 600; font-size: 14px; }
        
        /* Cards UI */
        .card { display: inline-flex; flex-direction: column; justify-content: space-between; width: 62px; height: 92px; background: white; color: #1e293b; border-radius: 8px; padding: 6px; font-weight: bold; font-size: 16px; cursor: pointer; border: 2px solid #cbd5e1; user-select: none; transition: transform 0.2s ease, box-shadow 0.2s ease; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .card:hover { transform: translateY(-5px); }
        .card.selected { border-color: #f59e0b; transform: translateY(-15px); box-shadow: 0 8px 15px rgba(245, 158, 11, 0.5); }
        .card.red { color: #dc2626; }
        .card-back { background: linear-gradient(135deg, #1e3a8a, #3b82f6); border: 2px solid #93c5fd; border-radius: 6px; width: 22px; height: 32px; display: inline-block; margin: 1px; box-shadow: 0 2px 4px rgba(0,0,0,0.4); }

        /* Table Center */
        .table-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; margin: 15px 0; }
        .played-cards-area { display: flex; gap: 15px; min-height: 100px; align-items: center; }

        /* Leaderboard Side Panel */
        .sidebar { width: 250px; background: #1e293b; border-radius: 16px; padding: 20px; border: 1px solid #334155; height: fit-content; }
        .sidebar h3 { margin-top: 0; color: #f59e0b; border-bottom: 2px solid #334155; padding-bottom: 8px; font-size: 18px; }
        .lb-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #334155; font-size: 14px; }

        #handArea { display: flex; justify-content: center; gap: 8px; min-height: 100px; padding: 10px; }
    </style>
</head>
<body>

<h1>♠️ სუპერ ბურა - ONLINE ♥️</h1>

<div id="lobby" class="lobby">
    <h3>შემოდი თამაშში</h3>
    <input type="text" id="username" placeholder="შეიყვანე სახელი" maxlength="12">
    <button class="btn" onclick="join()">შეერთება</button>
</div>

<div id="gameArea" style="display:none;" class="game-area">
    <div id="gameLayout">
        
        <!-- Table -->
        <div id="pokerTable">
            <div id="topPlayers" class="players-container"></div>

            <div class="table-center">
                <div style="color: #fef08a; font-weight: 600;" id="turnIndicator">მოლოდინი...</div>
                <div id="tableCardsArea" class="played-cards-area"></div>
            </div>

            <!-- Current Player Hand -->
            <div style="width: 100%; text-align: center;">
                <div id="handArea"></div>
                <button id="playBtn" class="btn" onclick="playSelected()" style="margin-top: 10px;">ჩამოსვლა</button>
            </div>
        </div>

        <!-- Leaderboard Sidebar -->
        <div class="sidebar">
            <h3>ლიდერბორდი 🏆</h3>
            <div id="leaderboardList"></div>
        </div>

    </div>
</div>

<script>
    const socket = io();
    let selectedIndices = [];
    let myHandData = [];
    let isMyTurn = false;

    function join() {
        const name = document.getElementById('username').value.trim();
        if(!name) return alert('გთხოვ შეიყვანო სახელი');
        socket.emit('joinGame', name);
        document.getElementById('lobby').style.display = 'none';
        document.getElementById('gameArea').style.display = 'block';
    }

    socket.on('updateRoom', (state) => {
        const me = state.players.find(p => p.socketId === socket.id);
        const meIndex = state.players.findIndex(p => p.socketId === socket.id);
        
        // Turn Status
        isMyTurn = state.gameStarted && (state.currentTurnIndex === meIndex);
        const activePlayer = state.players[state.currentTurnIndex];
        
        const turnInd = document.getElementById('turnIndicator');
        if(!state.gameStarted) {
            turnInd.innerText = \`ველოდებით მოთამაშეებს (\${state.players.length}/4)...\`;
        } else {
            turnInd.innerText = isMyTurn ? "🔥 შენი რიგია!" : \`რიგი აქვს: \${activePlayer ? activePlayer.name : ''}\`;
        }

        // Leaderboard
        const lb = document.getElementById('leaderboardList');
        lb.innerHTML = state.players.map(p => \`
            <div class="lb-item">
                <span>\${p.name}</span>
                <span><b>\${p.score}</b> ქ | ❌\${p.xishti}</span>
            </div>
        \`).join('');

        // Render Opponents
        const topP = document.getElementById('topPlayers');
        topP.innerHTML = '';
        state.players.forEach((p, idx) => {
            const isActive = state.gameStarted && (idx === state.currentTurnIndex);
            let cardsBacks = '';
            for(let i=0; i<p.handCount; i++) {
                cardsBacks += '<div class="card-back"></div>';
            }
            topP.innerHTML += \`
                <div class="player-spot \${isActive ? 'active' : ''}">
                    <div class="p-name">\${p.name}</div>
                    <div style="margin-top:5px;">\${cardsBacks}</div>
                </div>
            \`;
        });

        // My Hand
        if (me) {
            myHandData = me.hand || [];
            renderHand();
        }

        // Table Cards
        const tArea = document.getElementById('tableCardsArea');
        tArea.innerHTML = '';
        state.tableCards.forEach(item => {
            const c = item.card;
            const isRed = c.suit === '♦' || c.suit === '♥';
            tArea.innerHTML += \`
                <div style="text-align:center;">
                    <div style="font-size:11px; margin-bottom:2px; color:#cbd5e1;">\${item.playerName}</div>
                    <div class="card \${isRed ? 'red':''}">
                        <div>\${c.rank}</div>
                        <div>\${c.suit}</div>
                    </div>
                </div>
            \`;
        });
    });

    function renderHand() {
        const handDiv = document.getElementById('handArea');
        handDiv.innerHTML = '';
        myHandData.forEach((c, idx) => {
            const isRed = c.suit === '♦' || c.suit === '♥';
            const sel = selectedIndices.includes(idx) ? 'selected' : '';
            handDiv.innerHTML += \`
                <div class="card \${isRed ? 'red':''} \${sel}" onclick="toggleSelect(\${idx})">
                    <div>\${c.rank}</div>
                    <div>\${c.suit}</div>
                </div>
            \`;
        });
    }

    function toggleSelect(idx) {
        if(!isMyTurn) return;
        if(selectedIndices.includes(idx)) {
            selectedIndices = selectedIndices.filter(i => i !== idx);
        } else {
            selectedIndices.push(idx);
        }
        renderHand();
    }

    function playSelected() {
        if(!isMyTurn) return alert('ჯერ შენი რიგი არ არის!');
        if(selectedIndices.length === 0) return alert('აირჩიე კარტი ჩამოსასვლელად!');
        socket.emit('playCards', selectedIndices);
        selectedIndices = [];
    }

    socket.on('errorMsg', (msg) => alert(msg));
</script>
</body>
</html>
    `);
});

// ---------------- SOCKET.IO LOGIC ----------------
io.on('connection', (socket) => {

    socket.on('joinGame', (playerName) => {
        if (roomState.players.length >= roomState.maxPlayers) {
            socket.emit('errorMsg', 'ოთახი სავსეა!');
            return;
        }

        const player = {
            id: roomState.players.length,
            socketId: socket.id,
            name: playerName || მოთამაშე ${roomState.players.length + 1},
            hand: [],
            handCount: 0,
            score: 0,
            xishti: 0,
            roundPoints: 0,
            isXishtiThisRound: false
        };

        roomState.players.push(player);
        sendRoomUpdate();

        if (roomState.players.length === roomState.maxPlayers && !roomState.gameStarted) {
            startNewGame();
        }
    });

    socket.on('playCards', (cardIndices) => {
        const playerIndex = roomState.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex !== roomState.currentTurnIndex || !roomState.gameStarted) return;

        const player = roomState.players[playerIndex];

        // Get played cards
        let played = [];
        cardIndices.sort((a,b) => b - a).forEach(idx => {
            played.push(player.hand.splice(idx, 1)[0]);
        });
        player.handCount = player.hand.length;

        // Add to table
        played.forEach(c => {
            roomState.tableCards.push({ card: c, playerId: player.socketId, playerName: player.name });
        });

        // Move to NEXT player in strictly cyclic order
        roomState.currentTurnIndex = (roomState.currentTurnIndex + 1) % roomState.players.length;

        // Check if full round ended (all 4 players played)
        if (roomState.tableCards.length >= roomState.players.length) {
            evaluateRoundEnd();
        } else {
            sendRoomUpdate();
        }
    });

    socket.on('disconnect', () => {
        roomState.players = roomState.players.filter(p => p.socketId !== socket.id);
        if (roomState.players.length < roomState.maxPlayers) {
            roomState.gameStarted = false;
            roomState.tableCards = [];
        }
        sendRoomUpdate();
    });
});

function evaluateRoundEnd() {
    // 1. Calculate turn winner / points for this trick
    // (Simplification for round progression to next cards)
    
    // Check if hand finished -> draw cards for everyone strictly after round finishes
    setTimeout(() => {
        // Refill hands for all players after full trick is completed
        roomState.players.forEach(p => {
            while(p.hand.length < 5 && roomState.deck.length > 0) {
                p.hand.push(roomState.deck.pop());
            }
            p.handCount = p.hand.length;
        });

        roomState.tableCards = [];
        
        // Cyclic progression of starter based on lowest score / last xishti
        let nextStart = (roomState.roundStartIndex + 1) % roomState.players.length;
        roomState.roundStartIndex = nextStart;
        roomState.currentTurnIndex = nextStart;

        sendRoomUpdate();
    }, 1500);

    sendRoomUpdate();
}

function startNewGame() {
    roomState.gameStarted = true;
    roomState.deck = createDeck();
    roomState.tableCards = [];
    
    // First player who joined starts first
    roomState.currentTurnIndex = 0;
    roomState.roundStartIndex = 0;

    roomState.players.forEach(p => {
        p.hand = roomState.deck.splice(0, 5);
        p.handCount = p.hand.length;
        p.score = 0;
        p.xishti = 0;
    });

    sendRoomUpdate();
}

function sendRoomUpdate() {
    // Sanitize hand secret data for other players
    let sanitizedPlayers = roomState.players.map(p => ({
        socketId: p.socketId,
        name: p.name,
        handCount: p.hand.length,
        score: p.score,
        xishti: p.xishti
    }));

    roomState.players.forEach(p => {
        let customState = {
            ...roomState,
            players: sanitizedPlayers.map(sp => sp.socketId === p.socketId ? { ...sp, hand: p.hand } : sp)
        };
        io.to(p.socketId).emit('updateRoom', customState);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(სერვერი ჩაირთო პორტზე: ${PORT});
});
