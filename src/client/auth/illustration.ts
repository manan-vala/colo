import cloudRoad from "../assets/auth/cloud-road.jpg";
import lakeside from "../assets/auth/lakeside.jpg";
import rollingHills from "../assets/auth/rolling-hills.jpg";

const ILLUSTRATIONS = [cloudRoad, rollingHills, lakeside];

// One illustration is picked at module load (once per page load) and reused for the rest of
// that load, same as the document-list banner (src/client/home/banner.ts).
export const authIllustration = ILLUSTRATIONS[Math.floor(Math.random() * ILLUSTRATIONS.length)];
