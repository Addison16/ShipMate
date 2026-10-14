import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** What `make_picture` needs from the server. */
export interface PictureHost {
  /** Make a picture and show it on the reply. Returns what to tell the model. */
  make(description: string, signal: AbortSignal | undefined): Promise<string>;
}

/** Making pictures with the image model picked in Settings (the same one pets use). */
export function pictureTools(host: PictureHost): ToolDefinition[] {
  return [
    defineTool({
      name: "make_picture",
      label: "Make picture",
      description:
        "Make a picture (a drawing, photo-style image, poster or icon) and show it to the person on your reply. Describe what should be in it: subject, style, colors and mood. It can take a minute.",
      promptSnippet: "make_picture: make a picture and show it on your reply",
      parameters: Type.Object({
        description: Type.String({
          description: "what the picture shows, in one to three sentences",
        }),
      }),
      executionMode: "sequential",
      async execute(_id, p, signal) {
        const text = await host.make(p.description.trim().slice(0, 2000), signal);
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }),
  ];
}
