import WebSocket from 'ws'
const ws = new WebSocket(process.argv[2])
const filter = JSON.parse(process.argv[3])
ws.on('open', () => ws.send(JSON.stringify(['REQ','p',filter])))
ws.on('message', d => {
  const m = JSON.parse(String(d))
  if (m[0] === 'EVENT') console.log(m[2].id.slice(0,8), m[2].created_at, new Date(m[2].created_at*1000).toISOString())
  if (m[0] === 'EOSE') process.exit(0)
})
setTimeout(()=>process.exit(0), 8000)
