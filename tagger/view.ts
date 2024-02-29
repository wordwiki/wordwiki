import * as model from "./model.ts";
import {FieldVisitorI, Field, ScalarFieldBase, BooleanField, IntegerField, FloatField,
        StringField, IdField, PrimaryKeyField, RelationField, Schema} from "./model.ts";
import {unwrap, panic} from "../utils/utils.ts";

// export function buildView(schema: Schema): SchemaView {
//     // return new RelationSQLDriver(db, relationField,
//     //                              relationField.relationFields.map(r=>buildRelationSQLDriver(db, r)));
//     throw new Error();
// }

/**
 *
 */
export abstract class FieldView {
    constructor(public field: Field) {
    }

    abstract accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R;
}

/**
 *
 */
export abstract class ScalarFieldViewBase extends FieldView {
    declare field: ScalarFieldBase;
    constructor(field: ScalarFieldBase) { super(field); }
}

/**
 *
 */
export class BooleanFieldView extends ScalarFieldViewBase {
    declare field: BooleanField;
    constructor(field: BooleanField) { super(field); }
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitBooleanFieldView(this, a); }
}

/**
 *
 */
export class IntegerFieldView extends ScalarFieldViewBase {
    declare field: IntegerField;
    constructor(field: IntegerField) { super(field); }
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitIntegerFieldView(this, a); }
}

/**
 *
 */
export class FloatFieldView extends ScalarFieldViewBase {
    declare field: FloatField;
    constructor(field: FloatField) { super(field); }
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitFloatFieldView(this, a); }
}

/**
 *
 */
export class StringFieldView extends ScalarFieldViewBase {
    declare field: StringField;
    constructor(field: StringField) { super(field); }
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitStringFieldView(this, a); }
}

/**
 *
 */
export class IdFieldView extends ScalarFieldViewBase {
    declare field: IdField;
    constructor(field: IdField) { super(field); }
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitIdFieldView(this, a); }
}

/**
 *
 */
export class PrimaryKeyFieldView extends ScalarFieldViewBase {
    declare field: PrimaryKeyField;
    constructor(field: PrimaryKeyField) { super(field); }
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitPrimaryKeyFieldView(this, a); }
}

/**
 *
 */
export class RelationFieldView extends FieldView {
    declare field: RelationField;
    
    constructor(field: RelationField, public fieldView: FieldView[]) {
        super(field);
        //field.fields.map(new FieldVisitor<never,FieldView>
    }
    
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitRelationFieldView(this, a); }
}

/**
 *
 */
export class SchemaView extends RelationFieldView {
    declare field: Schema;
    relationViewForRelation: Map<RelationField, RelationFieldView>;
    
    constructor(public schema: Schema, fieldViews: FieldView[]) {
        super(schema, fieldViews);
        this.relationViewForRelation = new Map();
    }
    
    accept<A,R>(v: FieldViewVisitorI<A,R>, a: A): R { return v.visitSchemaView(this, a); }

    getRelationViewByName(relationName: string): RelationFieldView {
        return this.relationViewForRelation.get(
            this.schema.relationsByName[relationName] ?? panic('missing', relationName))
            ?? panic();
    }

    getRelationViewByTag(relationTag: string): RelationFieldView {
        return this.relationViewForRelation.get(
            this.schema.relationsByTag[relationTag] ?? panic('missing', relationTag))
            ?? panic();
    }
}

/**
 *
 */
export interface FieldViewVisitorI<A,R> {
    visitBooleanFieldView(f: BooleanFieldView, a: A): R;
    visitIntegerFieldView(f: IntegerFieldView, a: A): R;
    visitFloatFieldView(f: FloatFieldView, a: A): R;
    visitStringFieldView(f: StringFieldView, a: A): R;
    visitIdFieldView(f: IdFieldView, a: A): R;
    visitPrimaryKeyFieldView(f: PrimaryKeyFieldView, a: A): R;
    visitRelationFieldView(f: RelationFieldView, a: A): R;
    visitSchemaView(f: SchemaView, a: A): R;
}

// /**
//  *
//  */
// export class DataVisitor implements FieldVisitorI<any,void> {
//     visitField(f:Field, v:any) {}
//     visitBooleanField(f: BooleanField, v: any) { this.visitField(f, v); }
//     visitIntegerField(f: IntegerField, v: any) { this.visitField(f, v); }
//     visitFloatField(f: FloatField, v: any) { this.visitField(f, v); }
//     visitStringField(f: StringField, v: any) { this.visitField(f, v); }
//     visitIdField(f: IdField, v: any) { this.visitField(f, v); }
//     visitPrimaryKeyField(f: PrimaryKeyField, v: any) { this.visitField(f, v); }
//     visitRelationField(relationField: RelationField, v: any) {
//         relationField.modelFields.forEach(f=>f.accept(this, v[f.name]));
//     }
//     visitSchema(schema: Schema, v: any) {
//         schema.modelFields.forEach(f=>f.accept(this, v[f.name]));
//     }
// }

/**
 *
 */
export class FieldToFieldView implements FieldVisitorI<any,FieldView> {
    visitBooleanField(f: BooleanField, v: any): FieldView { return new BooleanFieldView(f); }
    visitIntegerField(f: IntegerField, v: any): FieldView { return new IntegerFieldView(f); }
    visitFloatField(f: FloatField, v: any): FieldView { return new FloatFieldView(f); }
    visitStringField(f: StringField, v: any): FieldView { return new StringFieldView(f); }
    visitIdField(f: IdField, v: any): FieldView { return new IdFieldView(f); }
    visitPrimaryKeyField(f: PrimaryKeyField, v: any): FieldView { return new PrimaryKeyFieldView(f); }
    visitRelationField(f: RelationField, v: any): FieldView {
        return new RelationFieldView(f, f.fields.map(fieldToFieldView));
    }
    visitSchema(f: Schema, v: any): FieldView {
        return new SchemaView(f, f.fields.map(fieldToFieldView));
    }
}

const fieldToFieldViewInst = new FieldToFieldView();

export function fieldToFieldView(f: Field): FieldView {
    return f.accept(fieldToFieldViewInst, undefined);
}
