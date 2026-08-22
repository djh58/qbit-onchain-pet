/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
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

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const response = url.pathname === "/_vinext/image"
      ? await handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        }, [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES])
      : await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; connect-src 'self' https://mempool.qbit.org; img-src 'self' blob:; font-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'",
    );
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export default worker;
