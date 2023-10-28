
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

class Goban {
    constructor (canvas, size_px) {
        this.ctx = canvas.getContext("2d");
        this.size = size_px;
        this.lines = 0;
        this.color = EMPTY;
        this.playing = EMPTY;

        canvas.onmousemove = e => {
            var rect = e.target.getBoundingClientRect();
            this.moveGhost(e.clientX - rect.left, e.clientY - rect.top);
        }

        canvas.onmouseleave = e => {
            this.removeGhost();
        }

        canvas.onclick = e => {
            if (this.canPlay) {
                var rect = e.target.getBoundingClientRect();
                let idx = this.coordsToIdx(e.clientX - rect.left, e.clientY - rect.top);
                this.putStone(idx);
            }
        }
    }

    get canPlay () {
        return this.color !== EMPTY && this.color == this.playing;
    }

    get hoshis () {
        switch(this.lines) {
            case 19:
                return [60, 66, 72, 174, 180, 186, 288, 294, 300];
            case 13:
                return [42, 48, 84, 120, 126];
            case 9:
                return [20, 24, 40, 56, 60];
        }
        return [];
    }

    putStone(idx) {
        if (this.board[idx] === 0 && this.canPlay) {
            this.onPut(idx)
        }
    }

    coordsToIdx(x, y) {
        return (this.lines * Math.floor(y/this.stoneSize)) + Math.floor(x/this.stoneSize);
    }

    moveGhost(x, y) {
        let prev = this.ghost;
        let idx = this.coordsToIdx(x, y);
        if (prev !== idx) {
            if (this.board[idx] === EMPTY) {
                this.ghost = idx;
                this.draw();
            } else {
                this.removeGhost();
            }
        }
    }

    removeGhost() {
        this.ghost = null;
        this.draw();
    }

    get stoneSize () {
        return this.size / this.lines
    }
    
    draw() {
        if (this.board === undefined || this.lines === 0) {
            return;
        }

        // Goban
        this.ctx.fillStyle = "peru";
        this.ctx.fillRect(0, 0, this.size, this.size);

        // Lines
        const start = this.stoneSize / 2;
        const l = this.size - start;

        this.ctx.strokeStyle = "black"
        this.ctx.beginPath();
        for (var x = start; x < this.size; x += this.stoneSize) {
            // V lines
            this.ctx.moveTo(x, start);
            this.ctx.lineTo(x, l);

            // H lines
            this.ctx.moveTo(start, x);
            this.ctx.lineTo(l, x);
        }
        this.ctx.stroke();

        // Hoshis
        this.ctx.fillStyle = "black";
        this.ctx.beginPath();
        this.hoshis.forEach(i => {
            if (this.board[i] === EMPTY) {
                const size = this.stoneSize;
                const x = size * (i % this.lines) + size/2;
                const y = size * Math.floor(i / this.lines) + size/2;
                this.ctx.moveTo(x, y);
                this.ctx.arc(x-0.5, y, 3, 0, Math.PI*2, false);
            }
        });
        this.ctx.fill();

        // Ghost
        if (this.ghost !== null && this.playing === this.color) {
            this.ctx.fillStyle = this.color === WHITE ? "rgb(255, 255, 255, 0.5)" : "rgb(0, 0, 0, 0.5)";
            this.ctx.beginPath();
            this.drawStone(this.ghost, this.color)
            this.ctx.fill();
        }

        const total = this.lines * this.lines;

        this.ctx.fillStyle = "black";
        this.ctx.beginPath();
        for (let i = 0; i < total; i++) {
            if (this.board[i] === BLACK) {
                this.drawStone(i, BLACK)
            }
        }
        this.ctx.fill();

        // white
        this.ctx.fillStyle = "white";
        this.ctx.beginPath();
        for (let i = 0; i < total; i++) {
            if (this.board[i] === WHITE) {
                this.drawStone(i, WHITE)
            }
        }
        this.ctx.fill();

    }

    drawStone (idx, color) {
        const size = this.stoneSize;
        const x = size * (idx % this.lines) + size/2;
        const y = size * Math.floor(idx / this.lines) + size/2;
        this.ctx.moveTo(x, y);
        this.ctx.arc(x, y, size/2 - 1, 0, Math.PI*2, false);
    }
}

function getUID() {
    var uid = localStorage.getItem("go2go_uid");
    if (uid) {
        return uid
    }
    uid = makeId()
    localStorage.setItem("go2go_uid", uid)
    return uid
}

function connect(gameId) {
    document.getElementById('game').style.display = 'block';

    const canvas = document.getElementById("canvas");
    var goban = new Goban(canvas, 500);

    var url = `ws://192.168.0.32:8080/play`

    if (gameId) {
        url = `${url}?g=${gameId}&p=${getUID()}`
    } else {
        const size = document.querySelector('input[name="size"]:checked').value;
        const color = document.querySelector('input[name="color"]:checked').value;
        document.getElementById('new-game').style.display = 'none';
        gameId = makeId()
        location.hash = `${gameId}`
        url = `${url}?g=${gameId}&p=${getUID()}&c=${color}&s=${size}`
    }

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    goban.onPut = (idx) => {
        const buffer = new ArrayBuffer(3);
        var dv = new DataView(buffer)
        dv.setUint8(0, goban.color);
        dv.setUint16(1, idx, true);
        ws.send(dv)
    }

    ws.onmessage = function(event) {
      if (event.data instanceof ArrayBuffer) {

        var dv = new DataView(event.data);

        if (dv.byteLength === 1) {
            // Set color
            goban.color = dv.getUint8(0);
        } else {
            // binary frame
            goban.board = new Uint8Array(event.data.slice(6))
            goban.playing = dv.getUint8(0);
            goban.lines = dv.getUint8(5);

            window.requestAnimationFrame(() => goban.draw() );
            
            document.getElementById('black').innerText = dv.getUint16(1, true);
            document.getElementById('white').innerText = dv.getUint16(3, true);
        }
      }
    }

    ws.onerror = function(event) {
        console.error(event)
    }
}

if (location.hash == '') {
    document.getElementById('new-game').style.display = 'block';
} else {
    connect(location.hash.substring(1))
}


function makeId() {
    var result           = '';
    var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < 12; i++ ) {
           result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}
