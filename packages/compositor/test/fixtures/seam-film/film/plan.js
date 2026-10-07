// The film's timing, shared by the page and the test that checks it.
export const FPS = 30;
export const WIDTH = 640;
export const HEIGHT = 360;
/** film 0 s shows the recording's 1.6 s: the click, its result, the quiet after */
export const CLIP = { at: 0, from: 1.6, to: 4.6 };
export const DURATION = 3;
/** the swap to the saved state: this long into the seam's window, on a frame */
export const SWAP_AFTER = 0.2;
/** @param {{ from: number }} window the seam's window (film s) */
export const swapAt = (window) => Math.ceil((window.from + SWAP_AFTER) * FPS - 1e-9) / FPS;
/** the lifted result starts to move at this frame, and fills the frame MORPH s later */
export const LIFT_AT = 60 / FPS;
export const MORPH = 0.5;
