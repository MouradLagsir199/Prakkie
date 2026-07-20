import type { ChainConnector } from './types';
import { ahConnector } from './ah';
import { aldiConnector } from './aldi';
import { detailresultConnector } from './detailresult';
import { jumboConnector } from './jumbo';
import { plusConnector } from './plus';
import { sparConnector } from './spar';
import { vomarConnector } from './vomar';
import { hoogvlietConnector } from './hoogvliet';
import { picnicConnector } from './picnic';
import { ekoplazaConnector } from './ekoplaza';

/**
 * chain id → connector (catalog.chains.connector names the connector; the
 * detailresult connector serves both dirk and dekamarkt).
 */
export const CONNECTORS: Record<string, ChainConnector> = {
  ah: ahConnector,
  jumbo: jumboConnector,
  plus: plusConnector,
  dirk: detailresultConnector,
  dekamarkt: detailresultConnector,
  aldi: aldiConnector,
  spar: sparConnector,
  vomar: vomarConnector,
  hoogvliet: hoogvlietConnector,
  picnic: picnicConnector,
  ekoplaza: ekoplazaConnector,
};

export function connectorFor(chainId: string): ChainConnector | undefined {
  return CONNECTORS[chainId];
}
