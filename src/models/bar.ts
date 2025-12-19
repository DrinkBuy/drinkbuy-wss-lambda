import mongoose, {Schema} from 'mongoose';
import {TypeDayEnum, TypeDayTypeEnum, TypeServiceModeEnum} from "../types";

export interface IOpenHourBar {
    day: TypeDayEnum; // E.g., "monday", "saturday"
    open: string; // E.g., "00:00"
    close: string; // E.g., "08:00"
    type: TypeDayTypeEnum; // E.g., "regular", "holiday", "event"
}

export interface IAddressBar {
    street_and_number: string,
    city: string,
    postal_code: string,
    country: string,
}

export interface IContactBar {
    country_code: string;
    phone_number: string;
    full_phone_number: string;
    email: string;
}

export interface IBar {
    _id?: mongoose.Types.ObjectId; // ObjectId is represented as a string in TypeScript
    name: string;
    description: string;
    cover_image: string;
    secondary_images: string[];
    address: IAddressBar;
    contact: IContactBar;
    views: number;
    hidden: boolean;
    loyalty_program: boolean;
    loyalty_program_name?: string;
    meters?: number;
    service_mode: TypeServiceModeEnum;
    min_order_price: number,
    table_service_price?: number,
    open_hours: IOpenHourBar[];
    status: {
        active: boolean;
        open_for_orders: boolean;
        table_service_on: boolean;
    };
    timezone: string;
    category: string;
    latitude: number;
    longitude: number;
    locale: string;
    created_at?: Date;
    updated_at?: Date;
}

const BarSchema = new Schema<IBar>({
    //_id: { type: mongoose.Schema.Types.ObjectId, required: false, default: new mongoose.Types.ObjectId() },
    name: { type: String, required: true },
    description: { type: String, required: true },
    cover_image: { type: String, required: true },
    secondary_images: { type: [String], default: [] },
    address: {
        _id: false,
        type: {
            street_and_number: { type: String, required: false, default: null },
            city: { type: String, required: false, default: null },
            postal_code: { type: String, required: false, default: null },
            country: { type: String, required: false, default: null },
        },
        required: true
    },
    contact: {
        country_code: { type: String, required: true },
        phone_number: { type: String, required: true },
        full_phone_number: { type: String, required: true },
        email: { type: String, required: true },
    },
    views: { type: Number, default: 0 },
    hidden: { type: Boolean, required: true, default: false },
    loyalty_program: { type: Boolean, required: true, default: false },
    loyalty_program_name: { type: String, required: false, default: undefined },
    meters: { type: Number, required: false, default: 0 },
    service_mode: { type: String, enum: Object.values(TypeServiceModeEnum), default: TypeServiceModeEnum.PICKUP },
    table_service_price: { type: Number, default: 0, required: false  },
    min_order_price: { type: Number, default: 0, required: false  },
    open_hours: {
        _id: false,
        type: [{
            day: { type: String, enum: Object.values(TypeDayEnum) },
            open: { type: String, required: false, default: "08:00" }, // E.g., "00:00"
            close: { type: String, required: false, default: "05:00" }, // E.g., "08:00"
            type: { type: String, enum: Object.values(TypeDayTypeEnum), default: TypeDayTypeEnum.REGULAR },
        }],
        required: false,
        default: []
    },
    status: {
        active: { type: Boolean, default: false },
        open_for_orders: { type: Boolean, default: false },
        table_service_on: { type: Boolean, default: true },
    },
    timezone: { type: String, required: false, default: "Europe/Copenhagen" },
    locale: { type: String, required: false, default: "en-GB" },
    category: { type: String, required: false, default: null },
    latitude: { type: Number, required: false , default: 0 },
    longitude: { type: Number, required: false , default: 0 },
    created_at: { type: Date, default: Date.now, required: false, index: true },
    updated_at: { type: Date, default: Date.now, required: true, index: true },
},{
    timestamps: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
    },
});

const BarModel = mongoose.model<IBar>('Bar', BarSchema);

export default BarModel;
