import {
  extractReceiptDraft,
  ReceiptOcrError,
  type ReceiptOcrProvider,
} from "../../receipt-ocr";

export const dynamic = "force-dynamic";

interface RuntimeEnv {
  AI?: ReceiptOcrProvider;
}

function responseJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function authenticatedEmail(request: Request) {
  const email = request.headers
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();
  if (!email) throw new ReceiptOcrError(401, "ChatGPT sign-in is required");
  return email.slice(0, 320);
}

async function workerProvider() {
  const workersRuntime = (await import("cloudflare:workers")) as unknown as {
    env: RuntimeEnv;
  };
  if (!workersRuntime.env.AI) {
    throw new ReceiptOcrError(
      503,
      "Server receipt reading is not configured yet. You can still enter the receipt totals manually.",
    );
  }
  return workersRuntime.env.AI;
}

export async function handleReceiptOcr(
  request: Request,
  provider: ReceiptOcrProvider,
) {
  authenticatedEmail(request);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ReceiptOcrError(400, "Receipt reading expects a photo upload");
  }
  const image = form.get("file") ?? form.get("image");
  if (!(image instanceof File)) {
    throw new ReceiptOcrError(400, "Receipt photo is required");
  }
  const draft = await extractReceiptDraft(provider, image);
  return responseJson({ draft }, 200);
}

export async function POST(request: Request) {
  try {
    return await handleReceiptOcr(request, await workerProvider());
  } catch (error) {
    if (error instanceof ReceiptOcrError) {
      return responseJson({ error: error.message }, error.status);
    }
    // Do not log image contents or extracted receipt text.
    console.error("BasketSense receipt OCR failed");
    return responseJson(
      { error: "The receipt reader could not process that photo" },
      500,
    );
  }
}
