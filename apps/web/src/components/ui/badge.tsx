import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none font-mono", {
  variants: {
    variant: {
      default: "bg-surface-3 text-muted",
      lime: "bg-lime/12 text-lime ring-1 ring-inset ring-lime/25",
      warn: "bg-warn/12 text-warn ring-1 ring-inset ring-warn/25",
      danger: "bg-danger/12 text-danger ring-1 ring-inset ring-danger/25",
      info: "bg-info/12 text-info ring-1 ring-inset ring-info/25",
      outline: "ring-1 ring-inset ring-line text-muted"
    }
  },
  defaultVariants: { variant: "default" }
});

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
