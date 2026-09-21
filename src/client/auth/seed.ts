// One creature is picked at module load (once per page load) and reused for the rest of that
// load, same as the document-list banner (src/client/home/banner.ts) the illustration replaced.
export const authSeed = crypto.randomUUID();
