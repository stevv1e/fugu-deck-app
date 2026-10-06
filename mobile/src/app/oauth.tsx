/** Возврат из браузера после входа (fugudeck://oauth). Ответ забирает openAuthSessionAsync — здесь только уходим назад. */
import { router } from "expo-router";
import { useEffect } from "react";

export default function OAuthReturn() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, []);
  return null;
}
