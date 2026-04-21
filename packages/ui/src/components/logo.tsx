import { ComponentProps } from "solid-js"

const icon = "./crimecode-icon.png"
const logo = "./crimecode-logo.png"

export const Mark = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-mark"
      src={icon}
      alt="OpenCode"
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
      src={logo}
      alt="OpenCode"
      classList={{ [props.class ?? ""]: !!props.class }}
      draggable={false}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return <img src={logo} alt="OpenCode" classList={{ [props.class ?? ""]: !!props.class }} draggable={false} />
}
