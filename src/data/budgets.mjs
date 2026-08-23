/**
 * Every budget this project enforces, in bytes.
 *
 * The single home for them, because there are two consumers that must not
 * disagree: `scripts/audit-budget.mjs`, which fails CI, and the Budgets table
 * on `/engineering`, which tells the reader what the gate allows. They did
 * disagree — the page advertised a 5.50 MB sequence ceiling against a gate set
 * at 5.00 — and a page contradicting its own build is the worst failure this
 * project can have.
 *
 * Plain ESM with no imports, so the node script can read it directly and the
 * app can import it through the bundler.
 *
 * Deliberately close to reality: a budget with slack in it is a budget nobody
 * respects.
 */

const KB = 1024;
const MB = 1024 * 1024;

/**
 * Four of these moved once, deliberately, when the device internals stopped
 * being flat emissive decals and became lit surfaces carrying roughness,
 * metalness and normal maps: desktop video 3.70 to 4.20 MB, desktop sequence
 * 5.00 to 5.40 MB, desktop peak frame 100 to 160 KB, mobile peak frame 64 to
 * 74 KB.
 *
 * They were not moved to make a failing gate pass. The peak frame was searched
 * first for something cheap to give back, and there was nothing. Cutting the
 * die's high-frequency detail bought 5%. Dropping WebP quality from 64 to 48 —
 * a visible loss across all 120 frames — bought 16% and still missed the old
 * ceiling. Splitting the frame in half priced the two regions in proportion to
 * their area, which is the signature of a picture that is uniformly denser
 * rather than one with a hot spot worth attacking.
 *
 * The frame costs more because it contains more. The budget now says so, and
 * says it once, here.
 */
export const BUDGETS = {
  /**
   * The VP9 streams the scrollytelling actually plays. 240 frames each; the
   * same frames as WebP stills would be about 9.9 MB and 2.1 MB.
   */
  desktopVideo: 4.2 * MB,
  mobileVideo: 1.5 * MB,
  /**
   * The still sequences are the fallback for browsers without WebCodecs, at a
   * coarser stride than the video. The peak frame is the deep push-in, where
   * the neural core fills the frame: bond wires, pad rings and a floorplan,
   * all of it lit rather than painted on.
   */
  desktopSequence: 5.4 * MB,
  desktopFrame: 160 * KB,
  mobileSequence: 1.7 * MB,
  mobileFrame: 74 * KB,
  /**
   * Only the pair the viewport actually loads. The inner still is the
   * expensive one: a thin high-contrast wireframe is the worst case for AVIF.
   */
  xrayPair: 240 * KB,
  noise: 6 * KB,
  /** First-load JS for "/", gzipped, excluding the frame sequence. */
  firstLoadJs: 180 * KB,
  /**
   * Every JS chunk the build produces, gzipped.
   *
   * First-load alone stopped being the whole story once the configurator
   * started pulling in three.js: ~135 KB gzip that correctly does not count
   * against first load, because it is fetched when that section mounts. Real
   * weight hiding in a lazy chunk is still real weight, and a budget that only
   * watches the first load is an invitation to move things out of it.
   */
  totalJs: 420 * KB,
};

/** Formats a budget for display. */
export const asMB = (n) => `${(n / MB).toFixed(2)} MB`;
export const asKB = (n) => `${Math.round(n / KB)} KB`;
