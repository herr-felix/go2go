/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import HTML from "./index.html";

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const OUT = 3;

const UP = 1;
const RIGHT = 2;
const DOWN = 3;
const LEFT = 4;

const directions = [UP,RIGHT,DOWN,LEFT]

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

	  	return handleApiRequest(path[0], request, env);

    });
  }
}


async function handleApiRequest(name, request, env) {

	let id;
	if (name.length <= 32) {
		id = env.games.idFromName(name);
	}  else {
		return new Response("Not found", {status: 404});
	}
	let gameObject = env.games.get(id);

	let newUrl = new URL(request.url);
	newUrl.pathname = "/" + name

	return gameObject.fetch(newUrl, request);
}


class Goban {
	offset = 6;

	constructor (board) {
		this.board = board;
		this.lines = this.board.getUint8(5);
		this.size = this.lines*this.lines;
	}

	isGroupDead (group) {
		for (let pos of group.values()) {
			for (let dir of directions) {
				if (this.at(this.at(pos, dir)) == EMPTY) {
					return false
				}
			}
		}
		return true
	}

	getGroup (start) {
		let color = this.at(start)
		let cluster = new Set()

		if (!(color == BLACK || color == WHITE)) {
			return cluster
		}

		let q = [];
		q.push(start)

		while (q.length > 0) {
			let pos = q.pop()
			if (this.at(pos) == color && !cluster.has(pos)) {
				cluster.add(pos)
				for (let dir of directions) {
					q.push(this.at(pos, dir)) // Left
				}
			}
		}
		return cluster
	}

	at (idx, direction) {
		switch (direction) {
			case UP:
      	return idx - this.lines
			case LEFT:
				if (idx % this.lines == 0) {
					return this.size // Out
				}
				return idx - 1
			case RIGHT:
				if (idx % this.lines + 1 == this.lines) {
					return this.size // Out
				}
				return idx + 1;
			case DOWN:
				return idx + this.lines
			default:
				if (idx < 0 || idx >= this.size) {
					return OUT;
				}
				return this.board.getUint8(idx + this.offset)
		}
	}

	setAt(idx, color) {
		this.board.setUint8(idx + this.offset, color)
	}

	play (pos, color) {
		//# Can only play on empty positions
		if (this.at(pos) !== EMPTY || pos > this.size || pos < 0) {
			return -1
		}

		let captured = new Set()
		let alive = new Set()
		let op_color = color ^ 2 + 1;

		this.setAt(pos, color);

		for (let dir of directions) {
			const p = this.at(pos, dir)
			if (this.at(p) == op_color &&  !(alive.has(p) || captured.has(p))) {
				let adjGroup = this.getGroup(p)
				if (this.isGroupDead(adjGroup)) {
					for (const x of adjGroup.values()) {
						captured.add(x)
					}
  			} else {
					for (const x of adjGroup.values()) {
						alive.add(x)
					}
				}
			}
		}

		// Group is dead and have no captured? Not a valid move
		if (captured.size == 0 && this.isGroupDead(this.getGroup(pos))) {
			this.setAt(pos, EMPTY) // Restore
			return -1 // No a valid move
		}

		// Remove captured
		for (let c of captured.values()) {
			this.setAt(c, EMPTY)
		}

		if (captured.size > 0) {
			if (color == BLACK) {
				this.board.setUint16(1, this.board.getUint16(1, true) + captured.size, true);
			} else {
				this.board.setUint16(3, this.board.getUint16(3, true) + captured.size, true);
			}
		}

		this.board.setUint8(0, color ^ 2 + 1)

		return captured.size
	}

}


export class GoGame {
  constructor(state, env) {
		this.state = state;
	}

	async fetch(request) {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);

			if (request.headers.get("Upgrade") != "websocket") {
				return new Response("expected websocket", {status: 400});
			}

			const pid = (new URLSearchParams(url.search)).get('p')

			let game = (await this.state.storage.get('game')) || {};
			const canPlay = pid && pid !== game.black && pid !== game.white;

			let pair = new WebSocketPair();

			if (!game.board || canPlay) {
				if (canPlay) {
					const color = (new URLSearchParams(url.search)).get('c')

					if (!game.black && color == "b") {
						game.black = pid
					} else if (!game.white && color == "w") {
						game.white = pid
					} else if (!game.black) {
						game.black = pid
					} else if (!game.white) {
						game.white = pid
					}
				}

				if (!game.board) {
					game.board = new DataView(new ArrayBuffer(361 + 7))
					game.board.setUint8(0, 1) // Set black as first to play

					const size = (new URLSearchParams(url.search)).get('s')
					switch (size) {
						case "9":
							game.board.setUint8(5, 9) // Set Size to 9
							break;
						case "13":
							game.board.setUint8(5, 13) // Set Size to 13
							break;
						default:
							game.board.setUint8(5, 19) // Set Size to 19
					}
				}
				await this.state.storage.put("game", game)
			}

			await this.handleSession(pair[1], game, pid);

			return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

	async handleSession(ws, game, pid) {
  	this.state.acceptWebSocket(ws)

		try {
		let msg = new Uint8Array(new ArrayBuffer(1))
		const color = pid === game.black ? 1 : pid === game.white ? 2 : 0;

		if (color > 0) {
			ws.serializeAttachment(color);
			msg[0] = color || 0;
			ws.send(msg)
		}
		ws.send(game.board)
		} catch (err) {
			console.log(err)
		}
	}

	async webSocketMessage(ws, msg) {
		let dv = new DataView(msg);
		let color = dv.getUint8(0);

		if (color == ws.deserializeAttachment()) {
			let pos = dv.getUint16(1, true);
			let game = await this.state.storage.get("game")
			let goban = new Goban(game.board)

			if (goban.play(pos, color) < 0) {
				return // Not a legal move
			}

			await this.state.storage.put("game", game)
			this.broadcast(game.board)
		}
	}

  webSocketClose(ws) {
		console.log(ws)
	}

	webSocketError(ws, msg) {
		console.error(msg)
	}

	broadcast(msg) {
		this.state.getWebSockets().forEach(sub => {
			try {
				sub.send(msg);
			} catch (err) {

			}
    });
	}

}
