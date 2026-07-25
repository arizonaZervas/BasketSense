import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  BETA_INTEREST: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/_vinext/image") {
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) =>
            (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response(),
        },
        [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
      );
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
