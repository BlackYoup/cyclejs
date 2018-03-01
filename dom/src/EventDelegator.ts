import xs, {Stream, Subscription} from 'xstream';
import {ScopeChecker} from './ScopeChecker';
import {IsolateModule} from './IsolateModule';
import {getSelectors, getTotalIsolatedScope, makeInsert} from './utils';
import {ElementFinder} from './ElementFinder';
import {EventsFnOptions} from './DOMSource';
import {Scope} from './isolate';
import SymbolTree from './SymbolTree';
import {
  fromEvent,
  preventDefaultConditional,
  PreventDefaultOpt,
} from './fromEvent';
declare var requestIdleCallback: any;

interface Destination {
  useCapture: boolean;
  bubbles: boolean;
  passive: boolean;
  scopeChecker: ScopeChecker;
  subject: Stream<Event>;
  preventDefault?: PreventDefaultOpt;
}

export interface CycleDOMEvent extends Event {
  propagationHasBeenStopped: boolean;
  ownerTarget: Element;
}

export const eventTypesThatDontBubble = [
  `blur`,
  `canplay`,
  `canplaythrough`,
  `durationchange`,
  `emptied`,
  `ended`,
  `focus`,
  `load`,
  `loadeddata`,
  `loadedmetadata`,
  `mouseenter`,
  `mouseleave`,
  `pause`,
  `play`,
  `playing`,
  `ratechange`,
  `reset`,
  `scroll`,
  `seeked`,
  `seeking`,
  `stalled`,
  `submit`,
  `suspend`,
  `timeupdate`,
  `unload`,
  `volumechange`,
  `waiting`,
];

interface DOMListener {
  sub: Subscription;
  passive: boolean;
  virtualListeners: number;
}

interface NonBubblingListener {
  sub: Subscription | undefined;
  destination: Destination;
}

/**
 * Manages "Event delegation", by connecting an origin with multiple
 * destinations.
 *
 * Attaches a DOM event listener to the DOM element called the "origin",
 * and delegates events to "destinations", which are subjects as outputs
 * for the DOMSource. Simulates bubbling or capturing, with regards to
 * isolation boundaries too.
 */
export class EventDelegator {
  private virtualListeners = new SymbolTree<
    Map<string, Set<Destination>>,
    Scope
  >(x => x.scope);
  private origin: Element;

  private domListeners: Map<string, DOMListener>;
  private nonBubblingListeners: Map<string, Map<Element, NonBubblingListener>>;

  private currentListeners: Set<Destination> = new Set<Destination>();
  private toDelete: Destination[] = [];
  private toDeleteSize = 0;

  constructor(
    private rootElement$: Stream<Element>,
    public isolateModule: IsolateModule,
  ) {
    this.isolateModule.setEventDelegator(this);
    this.domListeners = new Map<string, DOMListener>();
    this.nonBubblingListeners = new Map<
      string,
      Map<Element, NonBubblingListener>
    >();
    rootElement$.addListener({
      next: el => {
        if (this.origin !== el) {
          this.origin = el;
          this.resetEventListeners();
        }
        this.resetNonBubblingListeners();
      },
    });
  }

  public addEventListener(
    eventType: string,
    namespace: Array<Scope>,
    options: EventsFnOptions,
    bubbles?: boolean,
  ): Stream<Event> {
    const subject = xs.never();
    const scopeChecker = new ScopeChecker(namespace, this.isolateModule);

    const dest = this.insertListener(subject, scopeChecker, eventType, options);

    const shouldBubble =
      bubbles === undefined
        ? eventTypesThatDontBubble.indexOf(eventType) === -1
        : bubbles;
    if (shouldBubble) {
      if (!this.domListeners.has(eventType)) {
        this.setupDOMListener(eventType, !!options.passive);
      } else {
        const listener = this.domListeners.get(eventType) as DOMListener;
        this.domListeners.set(eventType, {
          ...listener,
          virtualListeners: listener.virtualListeners + 1,
        });
      }
    } else {
      const finder = new ElementFinder(namespace, this.isolateModule);
      this.setupNonBubblingListener(eventType, finder.call()[0], dest);
    }

    return subject;
  }

  public removeElement(element: Element, namespace?: Scope[]): void {
    if (namespace !== undefined) {
      //this.removeVirtualListener(namespace);
    }
    const toRemove: [string, Element][] = [];
    this.nonBubblingListeners.forEach((map, type) => {
      if (map.has(element)) {
        toRemove.push([type, element]);
      }
    });
    for (let i = 0; i < toRemove.length; i++) {
      const map = this.nonBubblingListeners.get(toRemove[i][0]) as Map<
        Element,
        NonBubblingListener
      >;
      map.delete(toRemove[i][1]);
      if (map.size === 0) {
        this.nonBubblingListeners.delete(toRemove[i][0]);
      } else {
        this.nonBubblingListeners.set(toRemove[i][0], map);
      }
    }
  }

  private insertListener(
    subject: Stream<Event>,
    scopeChecker: ScopeChecker,
    eventType: string,
    options: EventsFnOptions,
  ): Destination {
    const relevantSets: Set<Destination>[] = [];
    let namespace = scopeChecker.namespace
      .filter(n => n.type !== 'selector');

    do {
      relevantSets.push(
        this.getVirtualListeners(eventType, namespace, true)
      );
      namespace.splice(0, namespace.length - 1);
    } while(namespace.length > 0 && namespace[namespace.length - 1].type !== 'total');

    const destination = {
      ...options,
      scopeChecker,
      subject,
      bubbles: !!options.bubbles,
      useCapture: !!options.useCapture,
      passive: !!options.passive
    };

    for (let i = 0; i < relevantSets.length; i++) {
      relevantSets[i].add(destination);
    }

    return destination;
  }

  /**
   * Returns a set of all virtual listeners in the scope of the namespace
   * Set `exact` to true to treat sibiling isolated scopes as total scopes
   */
  private getVirtualListeners(
    eventType: string,
    namespace: Scope[],
    exact = false,
  ): Set<Destination> {
    let max = namespace.length;
    if (!exact) {
      for (let i = max - 1; i >= 0; i--) {
        if (namespace[i].type === 'total') {
          max = i + 1;
          break;
        }
      }
    }
    const map = this.virtualListeners.getDefault(
      namespace,
      () => new Map<string, Set<Destination>>(),
      max,
    );

    if (!map.has(eventType)) {
      map.set(eventType, new Set<Destination>());
    }
    return map.get(eventType) as Set<Destination>;
  }

  /*private removeVirtualListener(namespace: Scope[]): void {
    let curr: ListenerTree = this.virtualListeners;
    for (let i = 0; i < namespace.length; i++) {
      const child = curr[namespace[i].scope] as ListenerTree;
      if (child === undefined) {
        return;
      }
      if (i < namespace.length - 1) {
        curr = child;
      } else {
        const map = child[listenerSymbol] as Map<string, Destination[]>;
        map.forEach((arr, type) => {
          const listener = this.domListeners.get(type) as DOMListener;
          const newListener = {
            ...listener,
            virtualListeners: listener.virtualListeners - arr.length,
          };
          if (newListener.virtualListeners <= 0) {
            this.domListeners.delete(type);
          } else {
            this.domListeners.set(type, newListener);
          }
        });
        delete curr[namespace[i].scope];
      }
    }
  }*/

  private setupDOMListener(eventType: string, passive: boolean): void {
    const sub = fromEvent(
      this.origin,
      eventType,
      false,
      false,
      passive,
    ).subscribe({
      next: event => this.onEvent(eventType, event, passive),
      error: () => {},
      complete: () => {},
    });
    this.domListeners.set(eventType, {sub, passive, virtualListeners: 1});
  }

  private setupNonBubblingListener(
    eventType: string,
    element: Element,
    destination: Destination,
  ): void {
    let sub: Subscription | undefined = undefined;
    if (element) {
      sub = fromEvent(
        element,
        eventType,
        false,
        false,
        destination.passive,
      ).subscribe({
        next: ev => this.onEvent(eventType, ev, !!destination.passive, false),
        error: () => {},
        complete: () => {},
      });
    }
    if (!this.nonBubblingListeners.has(eventType)) {
      this.nonBubblingListeners.set(
        eventType,
        new Map<Element, NonBubblingListener>(),
      );
    }
    const map = this.nonBubblingListeners.get(eventType) as Map<
      Element,
      NonBubblingListener
    >;
    map.set(element, {sub, destination});
  }

  private resetEventListeners(): void {
    const iter = this.domListeners.entries();
    let curr = iter.next();
    while (!curr.done) {
      const [type, {sub, passive}] = curr.value;
      sub.unsubscribe();
      this.setupDOMListener(type, passive);
      curr = iter.next();
    }
  }

  private resetNonBubblingListeners(): void {
    const newMap = new Map<string, Map<Element, NonBubblingListener>>();
    const insert = makeInsert(newMap);

    this.nonBubblingListeners.forEach((map, type) => {
      map.forEach((value, elm) => {
        if (!document.body.contains(elm)) {
          const {sub, destination} = value;
          if (sub) {
            sub.unsubscribe();
          }
          const elementFinder = new ElementFinder(
            destination.scopeChecker.namespace,
            this.isolateModule,
          );
          const newElm = elementFinder.call()[0];
          const newSub = fromEvent(
            newElm,
            type,
            false,
            false,
            destination.passive,
          ).subscribe({
            next: event =>
              this.onEvent(type, event, !!destination.passive, false),
            error: () => {},
            complete: () => {},
          });
          insert(type, newElm, {sub: newSub, destination});
        } else {
          insert(type, elm, value);
        }
      });
      this.nonBubblingListeners = newMap;
    });
  }

  private resetCurrentListeners(
    listeners: Set<Destination>,
    useCapture: boolean,
    passive: boolean,
  ): void {
    this.currentListeners.clear();
    listeners.forEach(v => {
      if (v.useCapture === useCapture && v.passive === passive) {
        this.currentListeners.add(v);
      }
    });
  }

  private onEvent(
    eventType: string,
    event: Event,
    passive: boolean,
    bubbles = true,
  ): void {
    debugger;
    const namespace = this.isolateModule.getNamespace(event.target as Element);
    const rootElement = this.isolateModule.getRootElement(
      event.target as Element,
    );
    const cycleEvent = this.patchEvent(event);
    const listeners = this.getVirtualListeners(eventType, namespace);

    if (bubbles) {
      this.resetCurrentListeners(listeners, true, passive);
      this.bubble(
        eventType,
        event.target as Element,
        rootElement,
        cycleEvent,
        namespace,
        namespace.length - 1,
        true,
      );

      this.resetCurrentListeners(listeners, false, passive);
      this.bubble(
        eventType,
        event.target as Element,
        rootElement,
        cycleEvent,
        namespace,
        namespace.length - 1,
        false,
      );
    } else {
      /*
      //TODO: Add useCapture listener to this.currentListeners
      this.doBubbleStep(eventType, event.target as Element, cycleEvent);
      //TODO: Add useCapture listener to this.currentListeners
      this.doBubbleStep(eventType, event.target as Element, cycleEvent);
       */
    }
  }

  private bubble(
    eventType: string,
    elm: Element,
    rootElement: Element,
    event: CycleDOMEvent,
    namespace: Scope[],
    index: number,
    useCapture: boolean,
  ): void {
    if (!useCapture && !event.propagationHasBeenStopped) {
      this.doBubbleStep(eventType, elm, rootElement, event);
    }

    if (elm !== rootElement) {
      let newRoot = rootElement;
      let newIndex = index;
      if (elm === rootElement) {
        if (namespace[index].type === 'sibling') {
          newRoot = this.isolateModule.getRootElement(
            elm.parentNode as Element,
          );
          newIndex--;
        }
      }

      this.bubble(
        eventType,
        elm.parentNode as Element,
        newRoot,
        event,
        namespace,
        newIndex,
        useCapture,
      );
    }

    if (useCapture && !event.propagationHasBeenStopped) {
      this.doBubbleStep(eventType, elm, rootElement, event);
    }
  }

  private doBubbleStep(
    eventType: string,
    elm: Element,
    rootElement: Element,
    event: CycleDOMEvent,
  ): void {
    this.mutateEventCurrentTarget(event, elm);
    this.currentListeners.forEach(dest => {
      const sel = getSelectors(dest.scopeChecker.namespace);
      if (
        (sel !== '' && elm.matches(sel)) ||
        (sel === '' && elm === rootElement)
      ) {
        preventDefaultConditional(event, dest.preventDefault);
        dest.subject.shamefullySendNext(event);

        if (this.toDelete.length === this.toDeleteSize) {
          this.toDelete.push(dest);
        } else {
          this.toDelete[this.toDeleteSize] = dest;
        }
        this.toDeleteSize++;
      }
    });
    for(let i = 0; i < this.toDeleteSize; i++) {
      this.currentListeners.delete(this.toDelete[i]);
    }
    this.toDeleteSize = 0;
  }

  private patchEvent(event: Event): CycleDOMEvent {
    const pEvent = event as CycleDOMEvent;
    pEvent.propagationHasBeenStopped = false;
    const oldStopPropagation = pEvent.stopPropagation;
    pEvent.stopPropagation = function stopPropagation() {
      oldStopPropagation.call(this);
      this.propagationHasBeenStopped = true;
    };
    return pEvent;
  }

  private mutateEventCurrentTarget(
    event: CycleDOMEvent,
    currentTargetElement: Element,
  ) {
    try {
      Object.defineProperty(event, `currentTarget`, {
        value: currentTargetElement,
        configurable: true,
      });
    } catch (err) {
      console.log(`please use event.ownerTarget`);
    }
    event.ownerTarget = currentTargetElement;
  }
}
