
import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import { WorkerAuthProvider } from "./contexts/WorkerAuthContext";
import { SimulationBotProvider } from "./contexts/SimulationBotContext";
import { ProSimulationBotProvider } from "./contexts/ProSimulationBotContext";
import { PathSimulationBotProvider } from "./contexts/PathSimulationBotContext";
import ErrorBoundary from "./components/ErrorBoundary";
import Index from "./pages/Index";
import Portfolio from "./pages/Portfolio";
import Alerts from "./pages/Alerts";
import SimulationBot from "./pages/SimulationBot";
import RealTradingBot from "./pages/RealTradingBot";
import AdvancedAnalysis from "./pages/AdvancedAnalysis";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
    },
  },
});

const App = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <WorkerAuthProvider>
              {/* The sim-bot contexts live here, at the app root, not just on
                  /simulation-bot. Each one polls the server for its engine's real
                  state — mounting them only on one page meant every OTHER page's
                  `useXContextSafe()` returned null, so the home page's dashboard
                  fell through to a localStorage snapshot that nothing kept in
                  sync, and looked permanently reset regardless of what the bots
                  were actually doing on the server. */}
              <SimulationBotProvider>
              <ProSimulationBotProvider>
              <PathSimulationBotProvider>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/alerts" element={<Alerts />} />
                <Route path="/simulation-bot" element={<SimulationBot />} />
                <Route path="/real-trading" element={<RealTradingBot />} />
                <Route path="/advanced-analysis" element={<AdvancedAnalysis />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
              </PathSimulationBotProvider>
              </ProSimulationBotProvider>
              </SimulationBotProvider>
              </WorkerAuthProvider>
            </BrowserRouter>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
