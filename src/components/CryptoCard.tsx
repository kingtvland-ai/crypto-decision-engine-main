import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Eye, Clock, Shield, Target, Minus } from 'lucide-react';
import { CryptoRecommendation } from '@cde/engine';

const safeNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

interface CryptoCardProps {
  recommendation: CryptoRecommendation;
  isClickable?: boolean;
}

type Tone = 'profit' | 'loss' | 'neutral' | 'warning';

const PILL_CLASS: Record<Tone, string> = {
  profit: 'pill-profit',
  loss: 'pill-loss',
  neutral: 'pill-neutral',
  warning: 'pill-warning',
};

const TEXT_CLASS: Record<Tone, string> = {
  profit: 'text-profit',
  loss: 'text-loss',
  neutral: 'text-neutral',
  warning: 'text-warning',
};

/** A labelled metric whose colour carries meaning. The label is always present,
 *  so colour is reinforcement rather than the only channel. */
const Metric = ({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) => (
  <div className="flex items-baseline justify-between gap-2">
    <span className="text-muted-foreground">{label}</span>
    <span className={`tabular font-medium ${tone === 'neutral' ? 'text-foreground' : TEXT_CLASS[tone]}`}>
      {value}
    </span>
  </div>
);

const CryptoCard = ({ recommendation, isClickable = false }: CryptoCardProps) => {
  const {
    symbol,
    recommendation: rec,
    confidence,
    reasoning,
    indicators,
    currentPrice,
    priceChange24h,
    riskLevel,
    timeframe,
    suggestedAmounts
  } = recommendation;

  const safeCurrentPrice = safeNumber(currentPrice);
  const safePriceChange24h = safeNumber(priceChange24h);
  const safeRsi = safeNumber(indicators?.rsi, 50);
  const safeMa20 = safeNumber(indicators?.ma20, safeCurrentPrice);
  const safeMacd = safeNumber(indicators?.macd?.macd);
  const safeStochasticK = safeNumber(indicators?.stochastic?.k, 50);
  const safeSuggestedCrypto = safeNumber(suggestedAmounts?.crypto);

  const recTone: Tone = rec === 'buy' ? 'profit' : rec === 'sell' ? 'loss' : 'warning';
  const recText = rec === 'buy' ? 'קנייה' : rec === 'sell' ? 'מכירה' : 'החזקה';
  const RecIcon = rec === 'buy' ? TrendingUp : rec === 'sell' ? TrendingDown : Minus;

  // RSI: oversold reads as a buy signal (profit-coloured), overbought as a
  // warning. Never the other way round.
  const rsiTone: Tone = safeRsi < 30 ? 'profit' : safeRsi > 70 ? 'loss' : 'neutral';
  const riskTone: Tone = riskLevel === 'low' ? 'profit' : riskLevel === 'high' ? 'loss' : 'warning';
  const riskText = riskLevel === 'low' ? 'נמוך' : riskLevel === 'high' ? 'גבוה' : 'בינוני';
  const timeframeText = timeframe === 'short' ? 'קצר' : timeframe === 'long' ? 'ארוך' : 'בינוני';

  const macdTone: Tone = indicators.macd?.trend === 'bullish' ? 'profit'
    : indicators.macd?.trend === 'bearish' ? 'loss' : 'neutral';
  const stochTone: Tone = indicators.stochastic?.signal === 'oversold' ? 'profit'
    : indicators.stochastic?.signal === 'overbought' ? 'loss' : 'neutral';

  const up = safePriceChange24h >= 0;
  const ChangeIcon = up ? TrendingUp : TrendingDown;

  return (
    <Card
      className={[
        'glass-card border-0 overflow-hidden',
        // Hover changes colour and shadow only. The previous hover:scale-105
        // nudged every neighbouring card on a grid as the pointer moved.
        isClickable ? 'glass-card-interactive glass-sheen' : '',
      ].join(' ')}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 font-display text-lg font-bold">
            <span>{symbol}</span>
            {isClickable && <Eye className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          </CardTitle>
          <span className={`pill ${PILL_CLASS[recTone]} shrink-0`}>
            <RecIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {recText}
            <span className="tabular opacity-80">{confidence}%</span>
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="tabular font-display text-2xl font-bold">
            ${safeCurrentPrice.toLocaleString()}
          </span>
          <span className={`pill ${up ? 'pill-profit' : 'pill-loss'}`}>
            <ChangeIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tabular">{up ? '+' : ''}{safePriceChange24h.toFixed(2)}%</span>
            <span className="sr-only">{up ? 'עלייה' : 'ירידה'} ב-24 שעות</span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <Metric label="RSI" value={safeRsi.toFixed(1)} tone={rsiTone} />
          <Metric
            label="BB"
            value={indicators.bollingerBands.position === 'above' ? 'מעל'
              : indicators.bollingerBands.position === 'below' ? 'מתחת' : 'ביניים'}
          />
          <Metric label="MA20" value={`$${safeMa20.toLocaleString()}`} />
          <Metric
            label="נפח"
            value={indicators.volumeTrend === 'increasing' ? 'עולה'
              : indicators.volumeTrend === 'decreasing' ? 'יורד' : 'יציב'}
          />
          {indicators.macd && <Metric label="MACD" value={safeMacd.toFixed(4)} tone={macdTone} />}
          {indicators.stochastic && (
            <Metric label="Stoch" value={safeStochasticK.toFixed(0)} tone={stochTone} />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
          <span className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">סיכון:</span>
            <span className={`font-medium ${TEXT_CLASS[riskTone]}`}>{riskText}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">זמן:</span>
            <span className="font-medium">{timeframeText}</span>
          </span>
        </div>

        {suggestedAmounts && rec !== 'hold' && (
          <div className="rounded-lg border border-primary/25 bg-primary/10 p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              <span className="text-xs font-semibold text-primary">סכום מומלץ</span>
            </div>
            <div className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="tabular font-bold">${suggestedAmounts.usd}</span>
              <span className="tabular text-muted-foreground">
                {safeSuggestedCrypto.toFixed(6)} {symbol}
              </span>
            </div>
          </div>
        )}

        <div className="border-t border-border pt-3">
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{reasoning}</p>
          {isClickable && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-primary">
              <Eye className="h-3 w-3" aria-hidden="true" />
              לחץ לפירוט מלא
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default CryptoCard;
