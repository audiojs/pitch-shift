import { stftBatch as ftStftBatch, stftStream as ftStftStream, winSqFloor } from 'fourier-transform/stft'

// Thin wrapper over `fourier-transform/stft` that exposes `ratio` and `ratioFn`
// at the top of `ctx` (pitch-shift convention) in addition to FT's default
// `ctx.opts.*` surface. Atoms' process callbacks can continue to read
// `ctx.ratio` / `ctx.ratioFn` directly.

function wrapProcess(process) {
  return function (mag, phase, state, ctx) {
    if (ctx.ratio === undefined) ctx.ratio = ctx.opts?.ratio
    if (ctx.ratioFn === undefined) ctx.ratioFn = ctx.opts?.ratioFn ?? null
    return process(mag, phase, state, ctx)
  }
}

export function stftBatch(data, process, opts) {
  return ftStftBatch(data, wrapProcess(process), opts)
}

export function stftStream(process, opts) {
  let s = ftStftStream(wrapProcess(process), opts)
  return { write: (chunk) => s.write(chunk), flush: () => s.flush() }
}

export { winSqFloor }
