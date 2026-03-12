import { ReactNode } from "react";

export function PageContainer({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-[1220px] px-4 pb-8 pt-5 sm:px-6 lg:px-8">{children}</main>;
}
