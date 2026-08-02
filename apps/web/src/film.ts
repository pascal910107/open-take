/**
 * The take, played on a poster-and-play-button front. The video carries
 * `preload="none"`: it is 2.6 MB and nobody arrives to buffer it, so the
 * poster stands in until someone actually asks — the controls only appear
 * once they do, so the resting state stays a frame of the film.
 *
 * Scrolling it out of view pauses it, so audio-less footage never keeps
 * decoding off-screen.
 */
export function initFilm(video: HTMLVideoElement, playBtn: HTMLElement): void {
  playBtn.addEventListener("click", () => {
    playBtn.classList.add("hide");
    video.controls = true;
    void video.play();
  });

  video.addEventListener("ended", () => {
    video.controls = false;
    playBtn.classList.remove("hide");
  });

  new IntersectionObserver(
    (entries) => {
      if (!entries[0]?.isIntersecting && !video.paused) video.pause();
    },
    { threshold: 0.2 },
  ).observe(video);
}
