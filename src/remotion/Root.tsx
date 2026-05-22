import { Composition } from "remotion";
import { VisualizerComp, visualizerSchema, defaultVisualizerProps } from "./VisualizerComp";

export const RemotionRoot = () => {
  return (
    <Composition
      id="Visualizer"
      component={VisualizerComp}
      durationInFrames={1800}
      fps={30}
      width={1920}
      height={1080}
      schema={visualizerSchema}
      defaultProps={defaultVisualizerProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.ceil(props.durationSeconds * props.fps)),
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  );
};
