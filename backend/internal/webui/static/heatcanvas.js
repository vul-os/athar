/**
 * Renders click samples as a heat field on a canvas.
 *
 * Ported from the former src/components/HeatCanvas.jsx with the rendering
 * maths kept identical — this is the part of the dashboard the brief calls
 * out to port "nearly as-is" rather than reinvent. Only the lifecycle
 * changed: a React effect became an explicit start()/destroy() pair.
 *
 * The algorithm is the standard two-pass one, worth restating here rather
 * than reaching for a library:
 *
 *   1. Draw every point as a radial gradient in greyscale, accumulating with
 *      globalAlpha. Overlapping points sum, so density becomes intensity.
 *   2. Walk the resulting alpha channel and map each value through a colour
 *      ramp, writing RGB back.
 *
 * Doing it in two passes is what makes a heatmap a heatmap: colouring each
 * blob as it is drawn would just paint overlapping coloured circles, and
 * dense areas would not read hotter than sparse ones.
 *
 * The ramp runs blue -> cyan -> green -> amber -> red, the convention every
 * heatmap tool uses. It is not safe for red/green colour blindness, so
 * intensity is *also* encoded as alpha (cool areas are translucent, hot
 * areas opaque) — nobody has to resolve a hue to read this. The panel this
 * canvas sits on (see .heat-frame in ui.css) is a fixed neutral tone in both
 * light and dark mode specifically so the ramp's own contrast does not
 * change between themes: a cool blue at low alpha reads faint against a
 * near-black dark-mode surface but clear against this deliberately
 * mid-toned one, in both themes alike.
 */

/**
 * Maps 0..1 to the conventional heat ramp. Stops are interpolated in plain
 * RGB — perceptual interpolation would be more "correct", but the classic
 * ramp's appeal is precisely that people already know it, and "correcting"
 * it makes it less recognisable, not more.
 */
const STOPS = [
  [0.0, [40, 90, 210]], // blue — cold
  [0.3, [40, 190, 200]], // cyan
  [0.5, [60, 200, 110]], // green
  [0.7, [235, 175, 55]], // amber
  [1.0, [225, 55, 45]], // red — hot
]

function ramp(t) {
  const value = t <= 0 ? 0 : t >= 1 ? 1 : t
  for (let i = 1; i < STOPS.length; i++) {
    const [stopT, stopColor] = STOPS[i]
    if (value > stopT) continue
    const [prevT, prevColor] = STOPS[i - 1]
    const span = stopT - prevT
    const local = span === 0 ? 0 : (value - prevT) / span
    return [
      Math.round(prevColor[0] + (stopColor[0] - prevColor[0]) * local),
      Math.round(prevColor[1] + (stopColor[1] - prevColor[1]) * local),
      Math.round(prevColor[2] + (stopColor[2] - prevColor[2]) * local),
    ]
  }
  return STOPS[STOPS.length - 1][1]
}

/**
 * Mounts a heat canvas into `container` (which must already have a size —
 * absolute-positioned inset-0 over the wireframe frame, in practice) and
 * keeps it redrawn on resize. Returns { setSamples, destroy }.
 */
export function mountHeatCanvas(container, radius) {
  const canvas = document.createElement('canvas')
  canvas.className = 'heat-canvas'
  container.appendChild(canvas)

  let samples = []
  let frame = 0

  function draw() {
    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))

    // Render at device resolution so the field is not soft on a retina
    // screen, but cap the multiplier: at 3x a large canvas costs more to
    // colourise than the extra sharpness is worth.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    if (!samples.length) return

    // The blob radius scales with the canvas rather than being a fixed pixel
    // count: samples are positioned in percentages, so a fixed radius would
    // make the same data look like a fine spray on a wide canvas and a
    // single smear on a narrow one.
    const blobRadius = radius || Math.max(16, Math.min(46, width * 0.032))

    // Pass 1: accumulate density in greyscale. Alpha per point falls as the
    // sample count rises, so a page with 20 clicks and one with 2000 both
    // produce a readable field instead of either a faint dusting or one
    // saturated blob with no internal detail.
    const perPoint = Math.max(0.04, Math.min(0.35, 6 / Math.sqrt(samples.length)))

    for (const sample of samples) {
      const x = (sample.x / 100) * width
      const y = (sample.y / 100) * height

      const gradient = ctx.createRadialGradient(x, y, 0, x, y, blobRadius)
      gradient.addColorStop(0, `rgba(0,0,0,${perPoint})`)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(x, y, blobRadius, 0, Math.PI * 2)
      ctx.fill()
    }

    // Pass 2: map accumulated alpha through the colour ramp.
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = image.data

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha === 0) continue

      const [r, g, b] = ramp(alpha / 255)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      // Redundant alpha encoding: cool is translucent, hot is opaque. Floor
      // raised to 70 (from a plain 60) so the coldest points stay visible
      // against the frame's fixed mid-tone background in both themes.
      data[i + 3] = Math.min(255, 70 + alpha * 0.83)
    }
    ctx.putImageData(image, 0, 0)
  }

  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(draw)
  })
  observer.observe(container)

  return {
    setSamples(next) {
      samples = next || []
      draw()
    },
    destroy() {
      observer.disconnect()
      cancelAnimationFrame(frame)
      canvas.remove()
    },
  }
}
