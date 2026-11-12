// Each test file runs in an isolated process. Only tests covering the
// privileged paths opt into a synthetic owner for that process.
export const OWNER_ID = '719283746501928374';
process.env.OWAUA_OWNER_ID = OWNER_ID;
