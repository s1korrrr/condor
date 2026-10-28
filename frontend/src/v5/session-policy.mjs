/** A failed request cannot confirm that the secure session cookie was cleared. */
export async function confirmLogout(request, confirmed, failed) {
  try {
    await request();
  } catch {
    failed();
    return false;
  }
  confirmed();
  return true;
}
