import blueSky from "../assets/banners/blue-sky.webp";
import goldenHour from "../assets/banners/golden-hour.webp";
import nightSky from "../assets/banners/night-sky.webp";
import purpleMosaic from "../assets/banners/purple-mosaic.webp";

const BANNERS = [blueSky, goldenHour, nightSky, purpleMosaic];

/**
 * One banner is picked at module load (once per page load, including SPA reloads after a
 * deploy) and reused for the rest of that load — the module only runs once, so navigating
 * around the app keeps the same image, while an actual browser refresh re-picks.
 */
export const banner = BANNERS[Math.floor(Math.random() * BANNERS.length)];
