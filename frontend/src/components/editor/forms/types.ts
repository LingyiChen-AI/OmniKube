import type { K8sObject } from '../../../api/resource';

/** Every visual form receives the working draft and reports immutable updates. */
export interface FormProps {
  draft: K8sObject;
  onChange: (next: K8sObject) => void;
  /**
   * Create mode: forms surface a Basic-info section (name + namespace) so a
   * resource can be fully authored visually. On edit these are immutable and the
   * section is hidden.
   */
  creating?: boolean;
}

export type FormComponent = (props: FormProps) => JSX.Element;
