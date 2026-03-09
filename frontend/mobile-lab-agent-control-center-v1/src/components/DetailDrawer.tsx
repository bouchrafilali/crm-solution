import { AnimatePresence, motion } from "framer-motion";
import { ReactNode, useEffect } from "react";

interface DetailDrawerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

export function DetailDrawer({ open, title, subtitle, onClose, children }: DetailDrawerProps) {
  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            type="button"
            aria-label="Close detail drawer"
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          <motion.aside
            className="fixed right-0 top-0 z-50 h-full w-full max-w-2xl overflow-y-auto border-l border-slate-600/35 bg-slate-950/95 p-5 backdrop-blur-md"
            initial={{ x: 480 }}
            animate={{ x: 0 }}
            exit={{ x: 480 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">{title}</h3>
                {subtitle ? <p className="mt-1 text-xs text-slate-400">{subtitle}</p> : null}
              </div>
              <button type="button" onClick={onClose} className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium">
                Close
              </button>
            </div>

            {children}
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
