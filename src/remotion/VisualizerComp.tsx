import { z } from "zod";
import { AbsoluteFill, Audio, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { useAudioData, visualizeAudio } from "@remotion/media-utils";

const lyricLineSchema = z.object({ time: z.number(), text: z.string() });

export const visualizerSchema = z.object({
  audioUrl: z.string(),
  durationSeconds: z.number(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  backgroundUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  primary: z.string(),
  secondary: z.string(),
  accent: z.string(),
  glow: z.string(),
  bandCount: z.number(),
  sensitivity: z.number(),
  thickness: z.number(),
  reactivity: z.number(),
  lyrics: z.array(lyricLineSchema),
  lyricsEnabled: z.boolean(),
  lyricsColor: z.string(),
  lyricsFontFamily: z.string(),
  lyricsFontSize: z.number(),
});

export type VisualizerProps = z.infer<typeof visualizerSchema>;

export const defaultVisualizerProps: VisualizerProps = {
  audioUrl: "https://remotion-assets.s3.eu-central-1.amazonaws.com/silence.mp3",
  durationSeconds: 30,
  fps: 30,
  width: 1920,
  height: 1080,
  backgroundUrl: null,
  logoUrl: null,
  primary: "#7c3aed",
  secondary: "#22d3ee",
  accent: "#f472b6",
  glow: "#a78bfa",
  bandCount: 32,
  sensitivity: 1,
  thickness: 8,
  reactivity: 1.2,
  lyrics: [],
  lyricsEnabled: false,
  lyricsColor: "#ffffff",
  lyricsFontFamily: "Inter, sans-serif",
  lyricsFontSize: 56,
};

export const VisualizerComp: React.FC<VisualizerProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const audioData = useAudioData(props.audioUrl);

  const bars: number[] = audioData
    ? visualizeAudio({
        fps,
        frame,
        audioData,
        numberOfSamples: nearestPow2(props.bandCount * 2),
      }).slice(0, props.bandCount)
    : new Array(props.bandCount).fill(0);

  const currentTime = frame / fps;
  const activeLyric = props.lyricsEnabled
    ? [...props.lyrics].reverse().find((l) => l.time <= currentTime)
    : undefined;

  const barWidth = width / props.bandCount;
  const baseRadius = Math.min(width, height) * 0.18;

  return (
    <AbsoluteFill
      style={{
        background: props.backgroundUrl
          ? `#000`
          : `radial-gradient(circle at 50% 50%, ${props.primary}33, #050510 70%)`,
      }}
    >
      {props.backgroundUrl && (
        <AbsoluteFill>
          <Img
            src={props.backgroundUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.5 }}
          />
        </AbsoluteFill>
      )}

      {/* Radial bars */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <linearGradient id="barGrad" x1="0" x2="0" y1="1" y2="0">
              <stop offset="0%" stopColor={props.secondary} />
              <stop offset="100%" stopColor={props.primary} />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {bars.map((v, i) => {
            const angle = (i / props.bandCount) * Math.PI * 2 - Math.PI / 2;
            const mag = Math.min(1, v * props.sensitivity * props.reactivity * 4);
            const len = baseRadius * 0.35 + mag * baseRadius * 0.9;
            const cx = width / 2;
            const cy = height / 2;
            const x1 = cx + Math.cos(angle) * baseRadius;
            const y1 = cy + Math.sin(angle) * baseRadius;
            const x2 = cx + Math.cos(angle) * (baseRadius + len);
            const y2 = cy + Math.sin(angle) * (baseRadius + len);
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="url(#barGrad)"
                strokeWidth={props.thickness}
                strokeLinecap="round"
                filter="url(#glow)"
              />
            );
          })}
        </svg>
      </AbsoluteFill>

      {props.logoUrl && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Img
            src={props.logoUrl}
            style={{ width: baseRadius * 1.2, height: baseRadius * 1.2, objectFit: "contain" }}
          />
        </AbsoluteFill>
      )}

      {activeLyric && (
        <AbsoluteFill
          style={{
            alignItems: "center",
            justifyContent: "flex-end",
            paddingBottom: 120,
          }}
        >
          <div
            style={{
              color: props.lyricsColor,
              fontFamily: props.lyricsFontFamily,
              fontSize: props.lyricsFontSize,
              fontWeight: 700,
              textShadow: `0 0 24px ${props.glow}`,
              maxWidth: width * 0.8,
              textAlign: "center",
            }}
          >
            {activeLyric.text}
          </div>
        </AbsoluteFill>
      )}

      <Audio src={props.audioUrl} />
    </AbsoluteFill>
  );
};

function nearestPow2(n: number): 32 | 64 | 128 | 256 | 512 | 1024 | 2048 {
  const opts = [32, 64, 128, 256, 512, 1024, 2048] as const;
  for (const o of opts) if (o >= n) return o;
  return 2048;
}
