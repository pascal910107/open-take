// The Matroska stream writer lives in the compositor (the film renderer feeds
// its screenshots to ffmpeg through it too); the capture path imports it here.
export {
  jpegDimensions,
  matroskaCluster,
  matroskaHead,
  mjpegMatroska,
  type TimedFrame,
} from "@open-take/compositor";
