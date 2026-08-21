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

export const BUDGETS = {
  /**
   * The VP9 streams the scrollytelling actually plays. 240 frames each; the
   * same frames as WebP stills would be 9.09 MB and 2.00 MB.
   */
  desktopVideo: 3.7 * MB,
  mobileVideo: 1.5 * MB,
  /**
   * The still sequences are the fallback for browsers without WebCodecs, at a
   * coarser stride than the video. Peak frames are the exploded-view ones:
   * most silhouette, most detail.
   */
  desktopSequence: 5.0 * MB,
  desktopFrame: 100 * KB,
  mobileSequence: 1.7 * MB,
  mobileFrame: 64 * KB,
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
