import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: bounce signed-out visitors away from the dashboard.
 * Every page and API route still verifies the session against the database.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("wab_session");
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/dashboard") && !hasSession) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
