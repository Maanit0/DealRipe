export async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      res.ok
        ? "Unexpected non-JSON response from server."
        : `Server error ${res.status}. ${text.slice(0, 200)}`
    );
  }
}

export async function postJson(url: string, body: any): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await safeJson(res);
  if (data.error) throw new Error(data.error);
  return data;
}

export async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const data = await safeJson(res);
  if (data.error) throw new Error(data.error);
  return data;
}
