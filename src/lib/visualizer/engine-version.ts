/**
 * Version of the shared drawing engine (presets, effects, lyrics, audio
 * mapping). Bump this whenever draw output changes in a way the deployed
 * Lambda bundle must pick up. The app sends it with every render request and
 * the Remotion composition refuses to render when its own copy is older —
 * a clear "redeploy the bundle" error instead of a silently wrong video
 * (e.g. an unknown preset id falling back to the default preset).
 *
 * History:
 *  1 – original Lovable build (33 presets, 5 particle types)
 *  2 – glow-layer batching, new preset packs, onset-driven audio data,
 *      new effects, Google-font lyrics, chunk warm-up
 */
export const RENDER_ENGINE_VERSION = 2;
