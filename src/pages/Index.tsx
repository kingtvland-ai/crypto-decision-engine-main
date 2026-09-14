
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCryptoData } from '../hooks/useCryptoData';
import { usePortfolio } from '../hooks/usePortfolio';
import CryptoCard from '../components/CryptoCard';
import FearGreedIndicator from '../components/FearGreedIndicator';
import CryptoDetailModal from '../components/CryptoDetailModal';
import Navigation from '../components/Navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, BarChart3, TrendingUp } from 'lucide-react';
import SmartTipsPanel from '../components/SmartTipsPanel';
import MarketOverview from '../components/MarketOverview';
import { ExecutiveDashboard } from '../components/dashboard/ExecutiveDashboard';
import { CryptoRecommendation } from '@cde/engine';

const Index = () => {
  const { cryptoData, fearGreedData, recommendations, isLoading, error } = useCryptoData();
  const { portfolio } = usePortfolio();
  const [selectedCrypto, setSelectedCrypto] = useState<CryptoRecommendation | null>(null);
  // Filter recommendations based on user's portfolio
  const filteredRecommendations = recommendations?.filter(rec => {
    // Show buy recommendations for all cryptocurrencies
    if (rec.recommendation === 'buy') return true;
    
    // Show sell/hold recommendations only for cryptocurrencies user owns
    if (rec.recommendation === 'sell' || rec.recommendation === 'hold') {
      return portfolio?.items.some(item => item.symbol.toLowerCase() === rec.symbol.toLowerCase());
    }
    
    return false;
  }) || [];

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="flex items-center justify-center p-6">
            <div className="text-center">
              <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2 font-mono">שגיאה בטעינת הנתונים</h2>
              <p className="text-muted-foreground mb-4 font-mono">
                נתקלנו בבעיה בטעינת הנתונים. אנא רענן את הדף או נסה שוב מאוחר יותר.
              </p>
              <Button onClick={() => window.location.reload()} className="font-mono">
                רענן דף
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <div className="max-w-7xl mx-auto p-4">
        <div className="text-center mb-8">
          <h1 className="mb-3 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            מנוע החלטות קריפטו <span className="text-primary">AI</span>
          </h1>
          <p className="mx-auto mb-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            ניתוח טכני מתקדם • נתונים בזמן אמת • המלצות חכמות מבוססות AI
          </p>
          <div className="flex justify-center gap-3 flex-wrap">
            <Link to="/portfolio">
              <Button size="lg" className="flex cursor-pointer items-center gap-2">
                <BarChart3 className="w-5 h-5" aria-hidden="true" />
                עבור לתיק השקעות
              </Button>
            </Link>
            <Link to="/advanced-analysis">
              <Button variant="outline" size="lg" className="flex items-center gap-2 font-mono">
                <TrendingUp className="w-5 h-5" />
                ניתוח מתקדם
              </Button>
            </Link>
          </div>
        </div>

        {/* Executive Command Dashboard: Bybit Live Balance, Bots Status & Active Positions */}
        <ExecutiveDashboard />

        {fearGreedData && (
          <div className="mb-8 max-w-md mx-auto">
            <FearGreedIndicator fearGreedData={fearGreedData} />
          </div>
        )}

        {/* Market summary. Counts the SAME filtered set rendered below, and
            hides its own sentiment card because FearGreedIndicator sits right
            above it. */}
        {cryptoData && cryptoData.length > 0 && (
          <MarketOverview
            recommendations={filteredRecommendations}
            isLoading={isLoading}
            showSentiment={false}
          />
        )}

        <div className="mb-8">
          <h3 className="text-2xl font-semibold mb-6 flex items-center gap-2 font-mono text-primary">
            <BarChart3 className="w-6 h-6" />
            ניתוח מטבעות קריפטו מתקדם
          </h3>
          
          {filteredRecommendations && filteredRecommendations.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredRecommendations.map((recommendation) => (
                <div key={recommendation.symbol} onClick={() => setSelectedCrypto(recommendation)}>
                  <CryptoCard recommendation={recommendation} isClickable />
                </div>
              ))}
            </div>
          ) : (
            <Card className="bg-background border-primary/30">
              <CardContent className="p-8 text-center">
                <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2 font-mono">טוען נתוני ניתוח...</h3>
                <p className="text-muted-foreground font-mono">
                  מעבד נתונים טכניים ויוצר המלצות השקעה חכמות
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="mb-8">
          <SmartTipsPanel />
        </div>

        <div className="mt-12 text-center text-sm text-muted-foreground font-mono">
          <p className="mb-2">
            🔄 נתונים מתעדכנים כל דקה • 📊 מדד פחד וחמדנות מתעדכן כל שעה
          </p>
          <p>
            🤖 המלצות מבוססות AI וניתוח טכני מתקדם • ⚠️ לא מהווה ייעוץ השקעות
          </p>
        </div>

        <CryptoDetailModal 
          crypto={selectedCrypto}
          isOpen={!!selectedCrypto}
          onClose={() => setSelectedCrypto(null)}
        />
      </div>
    </div>
  );
};

export default Index;
