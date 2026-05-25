import { Toaster as Sonner, type ToasterProps } from "sonner"

// Theme follows the app's `dark` class on <html> (the app toggles it directly;
// no next-themes provider in this project).
function Toaster(props: ToasterProps) {
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      theme={theme}
      {...props}
    />
  )
}

export { Toaster }
