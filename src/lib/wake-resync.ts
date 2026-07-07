// Pure wake-resync decision (t099). An iOS PWA suspended through a server disconnect can miss
// the `disconnected` broadcast and wake showing a stale frame still labelled "Connected". On
// foreground the client pings and watches for any server signal during a short probe window;
// if the socket is believed up but stays silent, it's half-open — force a reconnect.
export function shouldResyncOnWake(input: {
  visible: boolean
  wsUp: boolean
  sawSignalDuringProbe: boolean
}): boolean {
  return input.visible && input.wsUp && !input.sawSignalDuringProbe
}
