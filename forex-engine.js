//+------------------------------------------------------------------+
//| Hakim Gold Signals EA V5.7                                      |
//| Cloudflare Worker -> MT5                                        |
//| PRIMARY: XAUUSD                                                  |
//| DEMO FIRST                                                        |
//+------------------------------------------------------------------+
#property strict
#property version   "5.7"
#property description "Hakim Gold Signals - Worker V5.7 Gold Priority"

#include <Trade/Trade.mqh>

CTrade trade;

//==================================================================
// SETTINGS
//==================================================================

input string WorkerURL =
   "https://forex-signal-engine.hakima09360.workers.dev/api/signals";

input double Lots = 0.01;

input ulong MagicNumber = 570015;

input int PollSeconds = 30;

input int WebRequestTimeout = 8000;

input int DeviationPoints = 30;

// فقط طلا
input bool GoldOnly = true;

// اجرای سفارش
// برای شروع فقط روی Demo استفاده شود.
input bool EnableTrading = true;

// حداقل امتیاز
input int MinimumScore = 80;

// حداکثر سفارش/پوزیشن متعلق به EA
input int MaxGoldOrders = 1;

// حداکثر فاصله Entry از قیمت فعلی بر حسب ATR
input double MaxEntryDistanceATR = 2.0;

// حداقل Risk/Reward
input double MinimumRiskReward = 1.30;

// استفاده از TP3 به عنوان TP نهایی
input bool UseTP3 = true;

// پیام تلگرام
input bool TelegramMessages = true;

input string TelegramBotToken = "";

input string TelegramChatID = "";

// اعتبار سیگنال بر حسب ثانیه
input int SignalMaxAgeSeconds = 900;

// حداقل فاصله مجاز از بازار
input double MinimumEntryDistancePoints = 20;

//==================================================================
// GLOBALS
//==================================================================

datetime LastPoll = 0;

string LastSignal = "";

double LastEntry = 0.0;

ulong LastKnownOrder = 0;

//==================================================================
// STRING HELPERS
//==================================================================

string TrimString(string s)
{
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
}

string Upper(string s)
{
   StringToUpper(s);
   return s;
}

//==================================================================
// JSON NUMBER EXTRACTION
//==================================================================

bool GetJsonNumber(
   string json,
   string key,
   double &value
)
{
   string pattern = "\"" + key + "\"";

   int pos = StringFind(json, pattern);

   if(pos < 0)
      return false;

   int colon = StringFind(json, ":", pos);

   if(colon < 0)
      return false;

   int start = colon + 1;

   while(
      start < StringLen(json) &&
      (
         StringGetCharacter(json,start) == ' ' ||
         StringGetCharacter(json,start) == '\n' ||
         StringGetCharacter(json,start) == '\r' ||
         StringGetCharacter(json,start) == '\t'
      )
   )
   {
      start++;
   }

   int end = start;

   while(end < StringLen(json))
   {
      ushort c = StringGetCharacter(json,end);

      if(
         (c >= '0' && c <= '9') ||
         c == '.' ||
         c == '-' ||
         c == '+' ||
         c == 'e' ||
         c == 'E'
      )
      {
         end++;
      }
      else
      {
         break;
      }
   }

   if(end <= start)
      return false;

   string numberText =
      StringSubstr(
         json,
         start,
         end-start
      );

   value = StringToDouble(numberText);

   return MathIsValidNumber(value);
}

//==================================================================
// JSON STRING EXTRACTION
//==================================================================

bool GetJsonString(
   string json,
   string key,
   string &value
)
{
   string pattern = "\"" + key + "\"";

   int pos = StringFind(json, pattern);

   if(pos < 0)
      return false;

   int colon = StringFind(json, ":", pos);

   if(colon < 0)
      return false;

   int quote1 = StringFind(json, "\"", colon + 1);

   if(quote1 < 0)
      return false;

   int quote2 = StringFind(json, "\"", quote1 + 1);

   if(quote2 < 0)
      return false;

   value =
      StringSubstr(
         json,
         quote1 + 1,
         quote2 - quote1 - 1
      );

   return true;
}

//==================================================================
// SYMBOL
//==================================================================

bool IsGoldSymbol()
{
   string symbol = _Symbol;

   StringToUpper(symbol);

   if(
      StringFind(symbol,"XAUUSD") >= 0 ||
      StringFind(symbol,"GOLD") >= 0
   )
   {
      return true;
   }

   return false;
}

//==================================================================
// URL ENCODE
//==================================================================

string UrlEncode(string text)
{
   string result = "";

   uchar bytes[];

   StringToCharArray(
      text,
      bytes,
      0,
      WHOLE_ARRAY,
      CP_UTF8
   );

   for(int i=0; i<ArraySize(bytes)-1; i++)
   {
      uchar c = bytes[i];

      if(
         (c >= 'a' && c <= 'z') ||
         (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') ||
         c == '-' ||
         c == '_' ||
         c == '.' ||
         c == '~'
      )
      {
         result += CharToString(c);
      }
      else
      {
         result += "%";

         result +=
            StringFormat(
               "%02X",
               c
            );
      }
   }

   return result;
}

//==================================================================
// TELEGRAM
//==================================================================

void SendTelegramMessage(string message)
{
   if(!TelegramMessages)
      return;

   if(
      TelegramBotToken == "" ||
      TelegramChatID == ""
   )
   {
      return;
   }

   string url =
      "https://api.telegram.org/bot" +
      TelegramBotToken +
      "/sendMessage";

   string body =
      "chat_id=" +
      UrlEncode(TelegramChatID) +
      "&text=" +
      UrlEncode(message);

   char data[];

   StringToCharArray(
      body,
      data,
      0,
      WHOLE_ARRAY,
      CP_UTF8
   );

   char result[];

   string headers;

   string responseHeaders;

   ResetLastError();

   int code =
      WebRequest(
         "POST",
         url,
         "application/x-www-form-urlencoded\r\n",
         5000,
         data,
         ArraySize(data)-1,
         result,
         responseHeaders
      );

   if(code != 200)
   {
      Print(
         "Telegram error HTTP=",
         code,
         " MT5Error=",
         GetLastError()
      );
   }
}

//==================================================================
// WORKER REQUEST
//==================================================================

bool GetWorkerSignals(string &response)
{
   char data[];

   char result[];

   string responseHeaders;

   ResetLastError();

   int code =
      WebRequest(
         "GET",
         WorkerURL,
         "",
         "",
         WebRequestTimeout,
         data,
         0,
         result,
         responseHeaders
      );

   if(code == -1)
   {
      Print(
         "Worker WebRequest failed. Error=",
         GetLastError()
      );

      return false;
   }

   if(code != 200)
   {
      Print(
         "Worker HTTP error: ",
         code
      );

      return false;
   }

   response =
      CharArrayToString(
         result,
         0,
         -1,
         CP_UTF8
      );

   if(StringLen(response) < 10)
   {
      Print(
         "Worker returned empty response."
      );

      return false;
   }

   return true;
}

//==================================================================
// FIND GOLD OBJECT
//==================================================================

bool ExtractGoldObject(
   string json,
   string &goldJson
)
{
   int symbolPos =
      StringFind(
         json,
         "\"symbol\":\"XAU/USD\""
      );

   if(symbolPos < 0)
   {
      symbolPos =
         StringFind(
            json,
            "\"symbol\": \"XAU/USD\""
         );
   }

   if(symbolPos < 0)
      return false;

   int objectStart =
      StringFind(
         json,
         "{",
         symbolPos - 100
      );

   if(objectStart < 0)
      return false;

   int objectEnd =
      StringFind(
         json,
         "}",
         symbolPos
      );

   if(objectEnd < 0)
      return false;

   goldJson =
      StringSubstr(
         json,
         objectStart,
         objectEnd - objectStart + 1
      );

   return true;
}

//==================================================================
// COUNT OUR ORDERS
//==================================================================

int CountOurGoldOrders()
{
   int count = 0;

   for(
      int i = OrdersTotal() - 1;
      i >= 0;
      i--
   )
   {
      ulong ticket =
         OrderGetTicket(i);

      if(ticket == 0)
         continue;

      if(
         OrderGetString(
            ORDER_SYMBOL
         ) != _Symbol
      )
      {
         continue;
      }

      long magic =
         OrderGetInteger(
            ORDER_MAGIC
         );

      if((ulong)magic != MagicNumber)
         continue;

      count++;
   }

   for(
      int i = PositionsTotal() - 1;
      i >= 0;
      i--
   )
   {
      ulong ticket =
         PositionGetTicket(i);

      if(ticket == 0)
         continue;

      if(
         PositionGetString(
            POSITION_SYMBOL
         ) != _Symbol
      )
      {
         continue;
      }

      long magic =
         PositionGetInteger(
            POSITION_MAGIC
         );

      if((ulong)magic != MagicNumber)
         continue;

      count++;
   }

   return count;
}

//==================================================================
// DUPLICATE CHECK
//==================================================================

bool HasSimilarPendingOrder(
   string signal,
   double entry
)
{
   for(
      int i = OrdersTotal() - 1;
      i >= 0;
      i--
   )
   {
      ulong ticket =
         OrderGetTicket(i);

      if(ticket == 0)
         continue;

      if(
         OrderGetString(
            ORDER_SYMBOL
         ) != _Symbol
      )
      {
         continue;
      }

      long magic =
         OrderGetInteger(
            ORDER_MAGIC
         );

      if((ulong)magic != MagicNumber)
         continue;

      ENUM_ORDER_TYPE type =
         (ENUM_ORDER_TYPE)
         OrderGetInteger(
            ORDER_TYPE
         );

      double orderPrice =
         OrderGetDouble(
            ORDER_PRICE_OPEN
         );

      bool typeOK = false;

      if(
         signal == "BUY LIMIT" &&
         type == ORDER_TYPE_BUY_LIMIT
      )
      {
         typeOK = true;
      }

      if(
         signal == "SELL LIMIT" &&
         type == ORDER_TYPE_SELL_LIMIT
      )
      {
         typeOK = true;
      }

      if(!typeOK)
         continue;

      double point =
         SymbolInfoDouble(
            _Symbol,
            SYMBOL_POINT
         );

      double tolerance =
         point * 20.0;

      if(
         MathAbs(
            orderPrice - entry
         ) <= tolerance
      )
      {
         return true;
      }
   }

   return false;
}

//==================================================================
// NORMALIZE PRICE
//==================================================================

double NormalizePrice(double price)
{
   int digits =
      (int)SymbolInfoInteger(
         _Symbol,
         SYMBOL_DIGITS
      );

   return NormalizeDouble(
      price,
      digits
   );
}

//==================================================================
// VALIDATE TRADE PLAN
//==================================================================

bool ValidateTradePlan(
   string signal,
   double entry,
   double sl,
   double tp
)
{
   MqlTick tick;

   if(!SymbolInfoTick(
      _Symbol,
      tick
   ))
   {
      Print(
         "Cannot read current market tick."
      );

      return false;
   }

   double point =
      SymbolInfoDouble(
         _Symbol,
         SYMBOL_POINT
      );

   int stopsLevel =
      (int)SymbolInfoInteger(
         _Symbol,
         SYMBOL_TRADE_STOPS_LEVEL
      );

   double brokerMinDistance =
      stopsLevel * point;

   double configuredMinDistance =
      MinimumEntryDistancePoints * point;

   double minDistance =
      MathMax(
         brokerMinDistance,
         configuredMinDistance
      );

   // -------------------------------------------------------------
   // BUY LIMIT
   // -------------------------------------------------------------

   if(signal == "BUY LIMIT")
   {
      if(entry >= tick.ask)
      {
         Print(
            "BUY LIMIT rejected: Entry ",
            entry,
            " >= Ask ",
            tick.ask
         );

         return false;
      }

      if(
         tick.ask - entry <
         minDistance
      )
      {
         Print(
            "BUY LIMIT rejected: Entry too close to market."
         );

         return false;
      }

      if(sl >= entry)
      {
         Print(
            "BUY LIMIT rejected: SL must be below Entry."
         );

         return false;
      }

      if(tp <= entry)
      {
         Print(
            "BUY LIMIT rejected: TP must be above Entry."
         );

         return false;
      }
   }

   // -------------------------------------------------------------
   // SELL LIMIT
   // -------------------------------------------------------------

   if(signal == "SELL LIMIT")
   {
      if(entry <= tick.bid)
      {
         Print(
            "SELL LIMIT rejected: Entry ",
            entry,
            " <= Bid ",
            tick.bid
         );

         return false;
      }

      if(
         entry - tick.bid <
         minDistance
      )
      {
         Print(
            "SELL LIMIT rejected: Entry too close to market."
         );

         return false;
      }

      if(sl <= entry)
      {
         Print(
            "SELL LIMIT rejected: SL must be above Entry."
         );

         return false;
      }

      if(tp >= entry)
      {
         Print(
            "SELL LIMIT rejected: TP must be below Entry."
         );

         return false;
      }
   }

   return true;
}

//==================================================================
// ATR DISTANCE VALIDATION
//==================================================================

bool ValidateEntryATR(
   string signal,
   double entry,
   double atr
)
{
   if(atr <= 0)
   {
      Print(
         "ATR unavailable. ATR distance filter skipped."
      );

      return true;
   }

   MqlTick tick;

   if(!SymbolInfoTick(
      _Symbol,
      tick
   ))
   {
      return false;
   }

   double marketPrice;

   if(signal == "BUY LIMIT")
      marketPrice = tick.ask;
   else
      marketPrice = tick.bid;

   double distance =
      MathAbs(
         marketPrice - entry
      );

   double maxDistance =
      atr * MaxEntryDistanceATR;

   if(
      distance > maxDistance
   )
   {
      Print(
         "Signal rejected: Entry distance ",
         distance,
         " > ATR limit ",
         maxDistance
      );

      return false;
   }

   return true;
}

//==================================================================
// RISK REWARD
//==================================================================

double CalculateRR(
   string signal,
   double entry,
   double sl,
   double tp
)
{
   double risk =
      MathAbs(
         entry - sl
      );

   double reward =
      MathAbs(
         tp - entry
      );

   if(risk <= 0)
      return 0;

   return reward / risk;
}

//==================================================================
// PLACE BUY LIMIT
//==================================================================

bool PlaceBuyLimit(
   double entry,
   double sl,
   double tp,
   string comment
)
{
   entry = NormalizePrice(entry);

   sl = NormalizePrice(sl);

   tp = NormalizePrice(tp);

   if(!ValidateTradePlan(
      "BUY LIMIT",
      entry,
      sl,
      tp
   ))
   {
      return false;
   }

   trade.SetExpertMagicNumber(
      MagicNumber
   );

   trade.SetDeviationInPoints(
      DeviationPoints
   );

   trade.SetTypeFillingBySymbol(
      _Symbol
   );

   bool result =
      trade.BuyLimit(
         Lots,
         entry,
         _Symbol,
         sl,
         tp,
         ORDER_TIME_GTC,
         0,
         comment
      );

   if(!result)
   {
      Print(
         "BUY LIMIT failed. Retcode=",
         trade.ResultRetcode(),
         " ",
         trade.ResultRetcodeDescription()
      );

      return false;
   }

   LastKnownOrder =
      trade.ResultOrder();

   Print(
      "BUY LIMIT placed. Ticket=",
      LastKnownOrder,
      " Entry=",
      entry,
      " SL=",
      sl,
      " TP=",
      tp
   );

   return true;
}

//==================================================================
// PLACE SELL LIMIT
//==================================================================

bool PlaceSellLimit(
   double entry,
   double sl,
   double tp,
   string comment
)
{
   entry = NormalizePrice(entry);

   sl = NormalizePrice(sl);

   tp = NormalizePrice(tp);

   if(!ValidateTradePlan(
      "SELL LIMIT",
      entry,
      sl,
      tp
   ))
   {
      return false;
   }

   trade.SetExpertMagicNumber(
      MagicNumber
   );

   trade.SetDeviationInPoints(
      DeviationPoints
   );

   trade.SetTypeFillingBySymbol(
      _Symbol
   );

   bool result =
      trade.SellLimit(
         Lots,
         entry,
         _Symbol,
         sl,
         tp,
         ORDER_TIME_GTC,
         0,
         comment
      );

   if(!result)
   {
      Print(
         "SELL LIMIT failed. Retcode=",
         trade.ResultRetcode(),
         " ",
         trade.ResultRetcodeDescription()
      );

      return false;
   }

   LastKnownOrder =
      trade.ResultOrder();

   Print(
      "SELL LIMIT placed. Ticket=",
      LastKnownOrder,
      " Entry=",
      entry,
      " SL=",
      sl,
      " TP=",
      tp
   );

   return true;
}

//==================================================================
// PROCESS SIGNAL
//==================================================================

void ProcessSignal(string json)
{
   string gold;

   if(!ExtractGoldObject(
      json,
      gold
   ))
   {
      Print(
         "XAU/USD object not found."
      );

      return;
   }

   string signal;

   if(!GetJsonString(
      gold,
      "signal",
      signal
   ))
   {
      Print(
         "Signal field not found."
      );

      return;
   }

   signal =
      TrimString(
         Upper(signal)
      );

   double score = 0;

   GetJsonNumber(
      gold,
      "score",
      score
   );

   Print(
      "Worker signal=",
      signal,
      " Score=",
      score
   );

   // فقط BUY LIMIT / SELL LIMIT
   if(
      signal != "BUY LIMIT" &&
      signal != "SELL LIMIT"
   )
   {
      return;
   }

   // -------------------------------------------------------------
   // SCORE
   // -------------------------------------------------------------

   if(score < MinimumScore)
   {
      Print(
         "Signal rejected by score: ",
         score
      );

      return;
   }

   // -------------------------------------------------------------
   // MAX ORDERS
   // -------------------------------------------------------------

   int existing =
      CountOurGoldOrders();

   if(existing >= MaxGoldOrders)
   {
      Print(
         "Maximum EA orders reached: ",
         existing
      );

      return;
   }

   // -------------------------------------------------------------
   // TRADE PLAN
   // -------------------------------------------------------------

   double entry = 0;

   double sl = 0;

   double tp1 = 0;

   double tp2 = 0;

   double tp3 = 0;

   double atr = 0;

   if(!GetJsonNumber(
      gold,
      "entry",
      entry
   ))
   {
      Print(
         "Entry not found."
      );

      return;
   }

   if(!GetJsonNumber(
      gold,
      "stopLoss",
      sl
   ))
   {
      Print(
         "StopLoss not found."
      );

      return;
   }

   GetJsonNumber(
      gold,
      "tp1",
      tp1
   );

   GetJsonNumber(
      gold,
      "tp2",
      tp2
   );

   GetJsonNumber(
      gold,
      "tp3",
      tp3
   );

   GetJsonNumber(
      gold,
      "atr",
      atr
   );

   if(
      entry <= 0 ||
      sl <= 0
   )
   {
      Print(
         "Invalid trade plan."
      );

      return;
   }

   // -------------------------------------------------------------
   // FINAL TP
   // -------------------------------------------------------------

   double finalTP = tp1;

   if(
      UseTP3 &&
      tp3 > 0
   )
   {
      finalTP = tp3;
   }
   else if(
      tp2 > 0
   )
   {
      finalTP = tp2;
   }

   if(finalTP <= 0)
   {
      Print(
         "No valid TP."
      );

      return;
   }

   // -------------------------------------------------------------
   // TRADE PLAN GEOMETRY
   // -------------------------------------------------------------

   if(signal == "BUY LIMIT")
   {
      if(sl >= entry || finalTP <= entry)
      {
         Print(
            "Invalid BUY LIMIT geometry."
         );

         return;
      }
   }

   if(signal == "SELL LIMIT")
   {
      if(sl <= entry || finalTP >= entry)
      {
         Print(
            "Invalid SELL LIMIT geometry."
         );

         return;
      }
   }

   // -------------------------------------------------------------
   // RISK / REWARD
   // -------------------------------------------------------------

   double rr =
      CalculateRR(
         signal,
         entry,
         sl,
         finalTP
      );

   Print(
      "Calculated R:R = ",
      DoubleToString(rr,2)
   );

   if(
      rr < MinimumRiskReward
   )
   {
      Print(
         "Signal rejected: R:R too low."
      );

      return;
   }

   // -------------------------------------------------------------
   // ATR ENTRY DISTANCE
   // -------------------------------------------------------------

   if(!ValidateEntryATR(
      signal,
      entry,
      atr
   ))
   {
      return;
   }

   // -------------------------------------------------------------
   // MARKET VALIDATION
   // -------------------------------------------------------------

   if(!ValidateTradePlan(
      signal,
      entry,
      sl,
      finalTP
   ))
   {
      return;
   }

   // -------------------------------------------------------------
   // DUPLICATE
   // -------------------------------------------------------------

   if(
      HasSimilarPendingOrder(
         signal,
         entry
      )
   )
   {
      Print(
         "Similar pending order already exists."
      );

      return;
   }

   // -------------------------------------------------------------
   // SAVE
   // -------------------------------------------------------------

   LastSignal = signal;

   LastEntry = entry;

   // -------------------------------------------------------------
   // TRADING DISABLED
   // -------------------------------------------------------------

   if(!EnableTrading)
   {
      string msg =
         "📡 Hakim Gold Signals\n\n" +
         "💎 XAUUSD\n" +
         "📊 " + signal + "\n" +
         "⭐ Score: " +
         DoubleToString(score,0) +
         "/100\n\n" +
         "📍 Entry: " +
         DoubleToString(entry,_Digits) +
         "\n🛑 SL: " +
         DoubleToString(sl,_Digits) +
         "\n🎯 TP: " +
         DoubleToString(finalTP,_Digits) +
         "\n📊 R:R: " +
         DoubleToString(rr,2) +
         "\n\n" +
         "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.\n" +
         "📊 این سیگنال بر اساس شرایط تکنیکال فعلی بازار تولید شده و با تغییر شرایط بازار ممکن است اعتبار آن از بین برود.";

      SendTelegramMessage(msg);

      Print(
         "Trading disabled. Signal only."
      );

      return;
   }

   // -------------------------------------------------------------
   // PLACE
   // -------------------------------------------------------------

   string comment =
      "HakimGold_V5.7";

   bool placed = false;

   if(signal == "BUY LIMIT")
   {
      placed =
         PlaceBuyLimit(
            entry,
            sl,
            finalTP,
            comment
         );
   }

   if(signal == "SELL LIMIT")
   {
      placed =
         PlaceSellLimit(
            entry,
            sl,
            finalTP,
            comment
         );
   }

   // -------------------------------------------------------------
   // TELEGRAM RESULT
   // -------------------------------------------------------------

   string message;

   if(placed)
   {
      message =
         "🟢 Hakim Gold EA V5.7\n\n" +
         "💎 XAUUSD\n" +
         "📊 " + signal + "\n" +
         "⭐ Score: " +
         DoubleToString(score,0) +
         "/100\n\n" +
         "📍 Entry: " +
         DoubleToString(entry,_Digits) +
         "\n🛑 SL: " +
         DoubleToString(sl,_Digits) +
         "\n🎯 TP: " +
         DoubleToString(finalTP,_Digits) +
         "\n📊 R:R: " +
         DoubleToString(rr,2) +
         "\n\n" +
         "📦 Pending order placed\n" +
         "🔢 Ticket: " +
         IntegerToString((int)LastKnownOrder) +
         "\n\n" +
         "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.\n" +
         "📊 این سیگنال بر اساس شرایط تکنیکال فعلی بازار تولید شده و با تغییر شرایط بازار ممکن است اعتبار آن از بین برود.";
   }
   else
   {
      message =
         "🔴 Hakim Gold EA V5.7\n\n" +
         "XAUUSD order FAILED\n" +
         signal +
         "\n\n" +
         "Entry: " +
         DoubleToString(entry,_Digits) +
         "\nSL: " +
         DoubleToString(sl,_Digits) +
         "\nTP: " +
         DoubleToString(finalTP,_Digits) +
         "\nR:R: " +
         DoubleToString(rr,2) +
         "\n\n" +
         "Check MT5 Experts/Journal.";
   }

   SendTelegramMessage(message);
}

//==================================================================
// TRADE TRANSACTION
//==================================================================

void OnTradeTransaction(
   const MqlTradeTransaction &trans,
   const MqlTradeRequest &request,
   const MqlTradeResult &result
)
{
   if(
      trans.type !=
      TRADE_TRANSACTION_DEAL_ADD
   )
   {
      return;
   }

   ulong deal =
      trans.deal;

   if(deal == 0)
      return;

   if(!HistoryDealSelect(deal))
      return;

   string symbol =
      HistoryDealGetString(
         deal,
         DEAL_SYMBOL
      );

   if(symbol != _Symbol)
      return;

   long magic =
      HistoryDealGetInteger(
         deal,
         DEAL_MAGIC
      );

   if((ulong)magic != MagicNumber)
      return;

   long entryType =
      HistoryDealGetInteger(
         deal,
         DEAL_ENTRY
      );

   double price =
      HistoryDealGetDouble(
         deal,
         DEAL_PRICE
      );

   double volume =
      HistoryDealGetDouble(
         deal,
         DEAL_VOLUME
      );

   double profit =
      HistoryDealGetDouble(
         deal,
         DEAL_PROFIT
      );

   // ENTRY
   if(
      entryType ==
      DEAL_ENTRY_IN
   )
   {
      string msg =
         "🟢 Hakim Gold EA V5.7\n\n" +
         "💎 XAUUSD معامله فعال شد\n" +
         "📌 Price: " +
         DoubleToString(price,_Digits) +
         "\n📦 Volume: " +
         DoubleToString(volume,2) +
         "\n\n" +
         "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.";

      SendTelegramMessage(msg);

      Print(
         "Position opened: ",
         price
      );
   }

   // EXIT
   if(
      entryType ==
      DEAL_ENTRY_OUT
   )
   {
      string resultText;

      if(profit > 0)
         resultText = "🟢 PROFIT";
      else if(profit < 0)
         resultText = "🔴 LOSS";
      else
         resultText = "⚪ BREAK EVEN";

      string msg =
         "📤 Hakim Gold EA V5.7\n\n" +
         "💎 XAUUSD معامله بسته شد\n\n" +
         resultText +
         "\n💰 P/L: " +
         DoubleToString(profit,2);

      SendTelegramMessage(msg);

      Print(
         "Position closed. Profit=",
         profit
      );
   }
}

//==================================================================
// INITIALIZATION
//==================================================================

int OnInit()
{
   trade.SetExpertMagicNumber(
      MagicNumber
   );

   trade.SetDeviationInPoints(
      DeviationPoints
   );

   trade.SetTypeFillingBySymbol(
      _Symbol
   );

   EventSetTimer(
      MathMax(
         5,
         PollSeconds
      )
   );

   Print(
      "================================================="
   );

   Print(
      "Hakim Gold Signals EA V5.7 started"
   );

   Print(
      "Worker: ",
      WorkerURL
   );

   Print(
      "Symbol: ",
      _Symbol
   );

   Print(
      "Lots: ",
      Lots
   );

   Print(
      "Magic: ",
      MagicNumber
   );

   Print(
      "Minimum Score: ",
      MinimumScore
   );

   Print(
      "Minimum R:R: ",
      MinimumRiskReward
   );

   Print(
      "Max Entry Distance ATR: ",
      MaxEntryDistanceATR
   );

   Print(
      "Signal Max Age: ",
      SignalMaxAgeSeconds,
      " seconds"
   );

   Print(
      "Trading: ",
      EnableTrading
   );

   Print(
      "================================================="
   );

   if(!IsGoldSymbol())
   {
      Print(
         "WARNING: Attach this EA to an XAUUSD/Gold chart."
      );
   }

   return INIT_SUCCEEDED;
}

//==================================================================
// DEINITIALIZATION
//==================================================================

void OnDeinit(
   const int reason
)
{
   EventKillTimer();

   Print(
      "Hakim Gold Signals EA V5.7 stopped."
   );
}

//==================================================================
// TIMER
//==================================================================

void OnTimer()
{
   datetime now =
      TimeCurrent();

   if(
      LastPoll != 0 &&
      now - LastPoll <
      PollSeconds
   )
   {
      return;
   }

   LastPoll = now;

   if(
      GoldOnly &&
      !IsGoldSymbol()
   )
   {
      return;
   }

   string response;

   bool ok =
      GetWorkerSignals(
         response
      );

   if(!ok)
   {
      return;
   }

   ProcessSignal(
      response
   );
}

//==================================================================
// TICK
//==================================================================

void OnTick()
{
   // Worker polling is handled by OnTimer().
}

//+------------------------------------------------------------------+
