"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { Check, Info, AlertTriangle, X, Loader2 } from "lucide-react"

// App toasts — a quieter, brand-aligned alternative to sonner's default
// richColors bars. Every toast sits on the warm ivory popover surface with a
// soft shadow; the only color is a small type-tinted icon in a rounded chip, so
// the toast reads as a calm notification rather than a loud colored banner.
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Each icon is wrapped in a small tinted chip (color comes from the chip,
      // not the whole toast). Stroke width kept consistent at 2.25 for weight.
      icons={{
        success: (
          <span className="cn-toast-icon cn-toast-icon-success">
            <Check className="size-3.5" strokeWidth={2.5} />
          </span>
        ),
        info: (
          <span className="cn-toast-icon cn-toast-icon-info">
            <Info className="size-3.5" strokeWidth={2.25} />
          </span>
        ),
        warning: (
          <span className="cn-toast-icon cn-toast-icon-warning">
            <AlertTriangle className="size-3.5" strokeWidth={2.25} />
          </span>
        ),
        error: (
          <span className="cn-toast-icon cn-toast-icon-error">
            <X className="size-3.5" strokeWidth={2.5} />
          </span>
        ),
        loading: (
          <span className="cn-toast-icon cn-toast-icon-loading">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
          </span>
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "color-mix(in oklab, var(--border) 70%, transparent)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          title: "cn-toast-title",
          description: "cn-toast-description",
          closeButton: "cn-toast-close",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
