import "@fontsource-variable/instrument-sans";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import { initFilm } from "./film";
import { initTheme } from "./theme";

/* The watch page is the film and the notes on it — no WebGL, so none of the
   landing's stage bundle is loaded here. Two behaviours, both shared. */

const film = document.getElementById("film") as HTMLVideoElement | null;
const filmPlay = document.getElementById("film-play");
if (film && filmPlay) initFilm(film, filmPlay);

initTheme();

/** Start the film at `seconds`, revealing the controls the way a play would. */
function seek(seconds: number): void {
  if (!film) return;

  // nothing about the resting state changes until the film can actually be
  // moved — hiding the play button first leaves a poster with no way in if
  // the media never arrives
  const land = (): void => {
    filmPlay?.classList.add("hide");
    film.controls = true;
    film.currentTime = seconds;
    film.play().catch(() => {
      // a deep link is not a user gesture, so autoplay can be refused. The
      // frame is already parked on the beat — hand the play button back and
      // let the visitor start it themselves.
      film.controls = false;
      filmPlay?.classList.remove("hide");
    });
  };

  // preload="none" means nothing has been fetched, and a currentTime set
  // against an empty element is dropped on the floor. Ask for metadata first —
  // only ever on the path where someone actually wants a specific beat.
  if (film.readyState === HTMLMediaElement.HAVE_NOTHING) {
    film.preload = "metadata";
    film.addEventListener("loadedmetadata", land, { once: true });
    film.load();
  } else {
    land();
  }
}

/* the beat list doubles as a set of cue points — clicking one seeks the film
   rather than just describing it, the same way `open-take beats` gives an
   agent a numbered map to refer to */
for (const cue of document.querySelectorAll<HTMLButtonElement>("[data-at]")) {
  cue.addEventListener("click", () => {
    seek(Number(cue.dataset.at));
    film?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

/* ?t=9 — so the deep links the Clip markup promises Google actually land */
const t = Number(new URLSearchParams(location.search).get("t"));
if (film && Number.isFinite(t) && t > 0) seek(t);
