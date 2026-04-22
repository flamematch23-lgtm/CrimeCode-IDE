import { ComponentProps } from "solid-js"

// Use ES module imports so the bundler (Vite/Rollup) rewrites the URL for
// every target: `/assets/crimecode-icon-HASH.png` for the web (served by
// Cloudflare Pages at the site root) AND `./assets/crimecode-icon-HASH.png`
// relative to the bundle for Electron where the page loads from
// file:///.../app.asar/out/renderer/index.html.
//
// Previous absolute paths like "/crimecode-icon.png" broke Electron because
// `/` resolves to the filesystem root (C:\) not inside the asar bundle.
import iconUrl from "../assets/crimecode-icon.png"
import logoUrl from "../assets/crimecode-logo.png"

export const Mark = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-mark"
      src={iconUrl}
      alt="CrimeCode"
      classList={{ [props.class ?? ""]: !!props.class }}
      draggable={false}
    />
  )
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      data-component="logo-splash"
      src={logoUrl}
      alt="CrimeCode"
      classList={{ [props.class ?? ""]: !!props.class }}
      draggable={false}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return <img src={logoUrl} alt="CrimeCode" classList={{ [props.class ?? ""]: !!props.class }} draggable={false} />
}
