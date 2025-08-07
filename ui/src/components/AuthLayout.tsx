import { useLocation, useNavigation, useSearchParams } from "react-router-dom";

import { Button, LinkButton } from "@components/Button";
import { GoogleIcon } from "@components/Icons";
import SimpleNavbar from "@components/SimpleNavbar";
import Container from "@components/Container";
import Fieldset from "@components/Fieldset";
import GridBackground from "@components/GridBackground";
import StepCounter from "@components/StepCounter";

interface AuthLayoutProps {
  title: string;
  description: string;
  cta: string;
  ctaHref: string;
  showCounter?: boolean;
}

export default function AuthLayout({
  title,
  description,
  cta,
  ctaHref,
  showCounter,
}: AuthLayoutProps) {
  const [sq] = useSearchParams();
  const location = useLocation();

  const returnTo = sq.get("returnTo") || location.state?.returnTo;
  const deviceId = sq.get("deviceId") || location.state?.deviceId;
  const navigation = useNavigation();

  return (
    <>
      <GridBackground />

      <div className="grid min-h-screen grid-rows-(--grid-layout)">
        <SimpleNavbar
          logoHref="/"
          actionElement={
            <div>
              <LinkButton to={ctaHref} text={cta} theme="light" size="MD" />
            </div>
          }
        />
        <Container>
          <div className="isolate flex h-full w-full items-center justify-center">
            <div className="-mt-16 max-w-2xl space-y-8">
              {showCounter ? (
                <div className="text-center">
                  <StepCounter currStepIdx={0} nSteps={2} />
                </div>
              ) : null}
              <div className="space-y-2 text-center">
                <h1 className="text-4xl font-semibold text-black dark:text-white">
                  {title}
                </h1>
                <p className="text-slate-600 dark:text-slate-400">{description}</p>
              </div>
            </div>
          </div>
        </Container>
      </div>
    </>
  );
}
