import { Config } from "@remotion/cli/config";
import path from "path";

Config.setVideoImageFormat("jpeg");
Config.setEntryPoint("src/remotion/index.ts");

Config.overrideWebpackConfig((current) => {
  return {
    ...current,
    resolve: {
      ...current.resolve,
      alias: {
        ...(current.resolve?.alias ?? {}),
        "@": path.resolve(__dirname, "src"),
      },
    },
  };
});
